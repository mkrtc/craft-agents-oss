import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionManager } from '@craft-agent/server-core/sessions'
import {
  BASELINE_IDLE_MS,
  MAIN_MEMORY_DIAGNOSTIC_GATE,
  POST_WORKLOAD_IDLE_MS,
  SESSION_OPEN_SPACING_MS,
  SYNTHETIC_SESSION_COUNT,
  WORKLOAD_DURATION_MS,
  captureSessionManagerCounters,
  createSyntheticFixturePlan,
  createWorkloadTraceManifest,
  estimateRetainedBytes,
  executeDiagnosticProtocolSchedule,
  isMainMemoryDiagnosticEnabled,
  requestExplicitGc,
  validateDiagnosticIsolation,
  type DiagnosticStage,
} from './main-memory'

function makeManaged(id: string, loaded: boolean, messages: unknown[]) {
  return {
    id,
    messagesLoaded: loaded,
    messages,
    runtimeGeneration: undefined,
    backgroundTaskRegistry: new Map(),
    backgroundShellCommands: new Map(),
    backgroundTaskOutputs: new Map(),
  }
}

function managerFrom(sessions: Map<string, unknown>, runtimeRegistry = new Map<string, unknown>()): SessionManager {
  return { sessions, runtimeRegistry } as unknown as SessionManager
}

describe('CRFT main-memory diagnostic gate', () => {
  it('is off unless the unique exact gate equals 1', () => {
    expect(isMainMemoryDiagnosticEnabled({})).toBe(false)
    expect(isMainMemoryDiagnosticEnabled({ [MAIN_MEMORY_DIAGNOSTIC_GATE]: '0' })).toBe(false)
    expect(isMainMemoryDiagnosticEnabled({ [MAIN_MEMORY_DIAGNOSTIC_GATE]: 'true' })).toBe(false)
    expect(isMainMemoryDiagnosticEnabled({ [MAIN_MEMORY_DIAGNOSTIC_GATE]: '1' })).toBe(true)
  })

  it('keeps the driver as a dynamic import inside the exact gate', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'index.ts'), 'utf8')
    expect(source).toContain("enabled: process.env.CRAFT_DIAG_MAIN_MEMORY !== '1' && !!process.env.SENTRY_ELECTRON_INGEST_URL")
    expect(source).toContain("if (process.env.CRAFT_DIAG_MAIN_MEMORY === '1')")
    expect(source).toContain("await import('./diagnostics/main-memory')")
    expect(source).not.toMatch(/^import .*diagnostics\/main-memory/m)
  })

  it('keeps the launcher branch-agnostic by requiring an immutable expected SHA', () => {
    const launcher = readFileSync(
      join(import.meta.dir, '..', '..', '..', '..', '..', 'scripts', 'diagnostics', 'run-crft-main-memory-v1.sh'),
      'utf8',
    )
    expect(launcher).toContain('<expected-git-sha>')
    expect(launcher).toContain('EXPECTED_GIT_SHA=$4')
    expect(launcher).toContain('ACTUAL_GIT_SHA=$(git -C "$REPO_ROOT" rev-parse --verify HEAD^{commit})')
    expect(launcher).toContain('GIT_SHA=$EXPECTED_GIT_SHA')
    expect(launcher).not.toContain('branch --show-current')
    expect(launcher).not.toContain('diag/chat-main-memory-attribution')
  })

  it('fails closed unless every required isolated root is unique and nested', () => {
    const root = '/tmp/crft-main-mem-v1-m0d-test'
    const env = {
      CRAFT_DIAG_MAIN_MEMORY: '1',
      CRAFT_HEADLESS: '1',
      CRAFT_RPC_HOST: '127.0.0.1',
      CRAFT_RPC_PORT: '0',
      CRAFT_DIAG_ROOT: root,
      HOME: `${root}/home`,
      XDG_CONFIG_HOME: `${root}/xdg-config`,
      XDG_CACHE_HOME: `${root}/xdg-cache`,
      XDG_DATA_HOME: `${root}/xdg-data`,
      CRAFT_CONFIG_DIR: `${root}/config`,
      CRAFT_DIAG_SESSION_ROOT: `${root}/workspace/sessions`,
      CRAFT_DIAG_WORKSPACE_ROOT: `${root}/workspace`,
      CRAFT_DIAG_OUTPUT_DIR: '/tmp/diagnostic-output',
      CRAFT_DIAG_RUN_ID: 'test-1',
      CRAFT_DIAG_GIT_SHA: 'a'.repeat(40),
    }
    expect(validateDiagnosticIsolation(env, ['--craft-diag-main-memory-smoke'], `${root}/user-data`).mode).toBe('smoke')
    expect(validateDiagnosticIsolation(env, ['--craft-diag-main-memory-smoke'], `${root}/user-data`).gitSha).toBe('a'.repeat(40))
    expect(() => validateDiagnosticIsolation(
      { ...env, CRAFT_DIAG_GIT_SHA: 'main' },
      ['--craft-diag-main-memory-smoke'],
      `${root}/user-data`,
    )).toThrow('must be a full lowercase SHA')
    expect(() => validateDiagnosticIsolation(
      { ...env, CRAFT_CONFIG_DIR: '/home/user/.craft-agent' },
      ['--craft-diag-main-memory-smoke'],
      `${root}/user-data`,
    )).toThrow('must be a distinct child')
    expect(() => validateDiagnosticIsolation(
      { ...env, XDG_CACHE_HOME: `${root}/xdg-config` },
      ['--craft-diag-main-memory-smoke'],
      `${root}/user-data`,
    )).toThrow('must be distinct')
  })
})

describe('redacted bounded counter arithmetic', () => {
  it('counts only loaded transcripts and never emits identifiers, content, or paths', () => {
    const loaded = makeManaged('secret-session-id', true, [
      { id: 'm1', role: 'user', content: 'SECRET_PROMPT', timestamp: 1 },
      { id: 'm2', role: 'assistant', content: 'answer', timestamp: 2 },
    ])
    loaded.backgroundTaskRegistry.set('private-task-id', {
      taskId: 'private-task-id', intent: 'SECRET_INTENT', status: 'completed', startTime: 1,
    })
    loaded.backgroundShellCommands.set('shell-id', 'cat /home/user/private-file')
    loaded.backgroundTaskOutputs.set('private-task-id', {
      outputFile: '/home/user/private-output.txt',
      summary: 'SECRET_SUMMARY',
      status: 'completed',
      completedAt: 2,
    })
    const cold = makeManaged('cold-secret-id', false, [{ id: 'hidden', content: 'SHOULD_NOT_COUNT' }])
    const generation = { token: 'runtime-secret', createdAt: 1 }
    ;(loaded as unknown as { runtimeGeneration: unknown }).runtimeGeneration = generation
    const manager = managerFrom(
      new Map([['secret-session-id', loaded], ['cold-secret-id', cold]]),
      new Map([['runtime-secret', { managed: loaded, generation }]]),
    )

    const counters = captureSessionManagerCounters(manager)
    expect(counters.transcripts.loadedSessionCount).toBe(1)
    expect(counters.transcripts.totalMessages).toBe(2)
    expect(counters.transcripts.perSession).toHaveLength(1)
    expect(counters.transcripts.perSession[0]!.sessionHash).toMatch(/^[0-9a-f]{64}$/)
    expect(counters.runtimes).toEqual({
      generationCount: 1,
      liveGenerationCount: 1,
      retainedBytesEstimate: expect.any(Number),
    })
    expect(counters.background.taskRegistryCount).toBe(1)
    expect(counters.background.shellCommandCount).toBe(1)
    expect(counters.background.taskOutputCount).toBe(1)
    expect(counters.background.retainedOutputBytes).toBeGreaterThan(0)

    const output = JSON.stringify(counters)
    for (const forbidden of [
      'secret-session-id', 'cold-secret-id', 'SECRET_PROMPT', 'SHOULD_NOT_COUNT',
      'private-task-id', 'SECRET_INTENT', '/home/user', 'SECRET_SUMMARY', 'runtime-secret',
    ]) {
      expect(output).not.toContain(forbidden)
    }
    for (const value of [
      counters.transcripts.retainedBytesEstimate,
      counters.runtimes.retainedBytesEstimate,
      counters.background.taskRegistryRetainedBytesEstimate,
      counters.background.shellCommandRetainedBytes,
      counters.background.retainedOutputBytes,
      counters.background.taskOutputRetainedBytesEstimate,
    ]) {
      expect(Number.isSafeInteger(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
    }
  })

  it('counts shared references once and fails closed on unreadable owners', () => {
    const shared = { text: 'abc' }
    expect(estimateRetainedBytes([shared, shared])).toBeLessThan(estimateRetainedBytes([{ text: 'abc' }, { text: 'abc' }]))
    expect(() => captureSessionManagerCounters({ sessions: [], runtimeRegistry: new Map() } as unknown as SessionManager))
      .toThrow('SessionManager.sessions is unavailable')
    const malformed = makeManaged('bad', true, []) as Record<string, unknown>
    malformed.messages = null
    expect(() => captureSessionManagerCounters(managerFrom(new Map([['bad', malformed]]))))
      .toThrow('messages are unreadable')
  })
})

describe('deterministic fixture, workload, and stage schedule', () => {
  it('defines exactly 25 strictly descending deterministic session sizes', () => {
    const first = createSyntheticFixturePlan()
    const second = createSyntheticFixturePlan()
    expect(first).toEqual(second)
    expect(first.sessions).toHaveLength(SYNTHETIC_SESSION_COUNT)
    expect(first.manifestHash).toMatch(/^[0-9a-f]{64}$/)
    for (let index = 1; index < first.sessions.length; index++) {
      expect(first.sessions[index]!.logicalPayloadBytes).toBeLessThan(first.sessions[index - 1]!.logicalPayloadBytes)
      expect(first.sessions[index]!.ordinal).toBe(index + 1)
    }
  })

  it('freezes the exact 60-second synthetic workload trace', () => {
    const trace = createWorkloadTraceManifest()
    expect(trace).toEqual({
      generator: 'CRFT-MAIN-MEM-V1-WORKLOAD',
      version: 1,
      tickMs: 50,
      ticks: 1_200,
      durationMs: 60_000,
      textDeltaCount: 1_200,
      textDeltaBytes: 38_400,
      toolResultCount: 60,
      toolResultBytes: 122_880,
      backgroundTaskCount: 6,
      transportEventCount: 1_260,
      traceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
  })

  it('orders baseline, 25 opens, post-load, workload, and idle deterministically', async () => {
    let now = 0
    const calls: Array<{ stage: DiagnosticStage; logicalElapsedMs: number; gc: boolean }> = []
    const opened: number[] = []
    let workloadRuns = 0
    await executeDiagnosticProtocolSchedule({
      clock: {
        now: () => now,
        sleep: async ms => { now += ms },
      },
      timing: {
        baselineIdleMs: BASELINE_IDLE_MS,
        sessionOpenSpacingMs: SESSION_OPEN_SPACING_MS,
        workloadDurationMs: WORKLOAD_DURATION_MS,
        postWorkloadIdleMs: POST_WORKLOAD_IDLE_MS,
      },
      openSession: async index => { opened.push(index) },
      runWorkload: async () => { workloadRuns += 1; now += WORKLOAD_DURATION_MS },
      capture: async (stage, logicalElapsedMs, gc) => { calls.push({ stage, logicalElapsedMs, gc }) },
    })

    expect(opened).toEqual(Array.from({ length: 25 }, (_, index) => index))
    expect(workloadRuns).toBe(1)
    const expectedStages: DiagnosticStage[] = [
      'baseline',
      ...Array.from({ length: 25 }, (_, index) => `open-${String(index + 1).padStart(2, '0')}` as DiagnosticStage),
      'post-load',
      'post-workload',
      'post-idle',
    ]
    expect(calls.map(call => call.stage)).toEqual(expectedStages)
    expect(calls.filter(call => call.gc).map(call => call.stage)).toEqual(['baseline', 'post-load', 'post-idle'])
    expect(calls.at(-1)!.logicalElapsedMs).toBe(
      BASELINE_IDLE_MS + 25 * SESSION_OPEN_SPACING_MS + WORKLOAD_DURATION_MS + POST_WORKLOAD_IDLE_MS,
    )
    expect(now).toBe(calls.at(-1)!.logicalElapsedMs)
  })
})

describe('explicit GC reporting', () => {
  it('reports unavailable without --expose-gc and completes two checkpoints when exposed', async () => {
    expect(await requestExplicitGc(undefined)).toEqual({ requested: true, available: false, completed: false })
    let calls = 0
    expect(await requestExplicitGc(() => { calls += 1 })).toEqual({ requested: true, available: true, completed: true })
    expect(calls).toBe(2)
  })
})
