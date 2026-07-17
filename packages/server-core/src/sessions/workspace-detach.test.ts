import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __setConfigDirForTests } from '@craft-agent/shared/config/paths'
import { detachWorkspaceConfig, loadStoredConfig, saveConfig } from '@craft-agent/shared/config'
import type { Workspace } from '@craft-agent/core/types'
import { SessionManager, WorkspaceAdmissionError } from './SessionManager'

let root: string
let workspace: Workspace

function hooks(overrides: Record<string, unknown> = {}) {
  return {
    detachConfig: () => detachWorkspaceConfig(workspace.id),
    ...overrides,
  }
}

function startBarrierAdmission(manager: SessionManager, kind: 'session' | 'background') {
  let finish!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => { finish = resolve })
  const admitted = new Promise<void>((resolve) => { started = resolve })
  const operation = (async () => {
    const release = (manager as any).acquireWorkspaceAdmission(workspace.id, kind) as () => void
    started()
    try {
      await gate
    } finally {
      release()
    }
  })()
  return { admitted, finish, operation }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'craft-session-workspace-detach-'))
  const configDir = join(root, 'config')
  const workspaceRoot = join(root, 'workspace')
  mkdirSync(workspaceRoot, { recursive: true })
  __setConfigDirForTests(configDir)
  workspace = {
    id: 'ws-detach',
    name: 'Detach',
    slug: 'detach',
    rootPath: workspaceRoot,
    createdAt: 1,
  }
  saveConfig({ workspaces: [workspace], activeWorkspaceId: workspace.id, activeSessionId: null })
})

afterEach(() => {
  __setConfigDirForTests(null)
  rmSync(root, { recursive: true, force: true })
})

describe('SessionManager workspace detach lifecycle', () => {
  it('freezes admission before the final activity check and refuses barrier-controlled session create work', async () => {
    const manager = new SessionManager()
    const create = startBarrierAdmission(manager, 'session')
    await create.admitted
    let detached = false

    const result = await manager.removeWorkspace(workspace.id, hooks({
      freezeExternalAdmission: () => {
        expect(() => manager.assertWorkspaceAdmission(workspace.id, 'background')).toThrow(WorkspaceAdmissionError)
      },
      detachConfig: () => { detached = true; return true },
    }))

    expect(result).toEqual({ ok: false, code: 'active-session', retryable: true })
    expect(detached).toBe(false)
    create.finish()
    await create.operation
  })

  it('refuses a barrier-controlled send admission and reopens admission without config mutation', async () => {
    const manager = new SessionManager()
    const send = startBarrierAdmission(manager, 'session')
    await send.admitted
    const result = await manager.removeWorkspace(workspace.id, hooks())
    expect(result.code).toBe('active-session')
    expect(loadStoredConfig()?.workspaces).toHaveLength(1)
    expect(() => manager.assertWorkspaceAdmission(workspace.id, 'background')).not.toThrow()
    send.finish()
    await send.operation
  })

  it('reports task, automation, and background activity with their typed refusal codes', async () => {
    const taskManager = new SessionManager()
    ;(taskManager as any).taskConductor = {
      hasNonTerminalRuns: () => true,
      releaseWorkspace: () => { throw new Error('must not release active task') },
    }
    expect((await taskManager.removeWorkspace(workspace.id, hooks())).code).toBe('active-task')

    const automationManager = new SessionManager()
    const releaseAutomation = (automationManager as any).acquireWorkspaceAdmission(workspace.id, 'automation') as () => void
    expect((await automationManager.removeWorkspace(workspace.id, hooks())).code).toBe('active-background')
    releaseAutomation()

    const backgroundManager = new SessionManager()
    const releaseBackground = (backgroundManager as any).acquireWorkspaceAdmission(workspace.id, 'background') as () => void
    expect((await backgroundManager.removeWorkspace(workspace.id, hooks())).code).toBe('active-background')
    releaseBackground()
  })

  it('refuses a barrier-controlled automation dispatch and rejects new automation after freeze', async () => {
    const manager = new SessionManager()
    let finishCreate!: () => void
    let createStarted!: () => void
    const createGate = new Promise<void>((resolve) => { finishCreate = resolve })
    const started = new Promise<void>((resolve) => { createStarted = resolve })
    ;(manager as any).createSession = async () => {
      createStarted()
      await createGate
      throw new Error('test stop')
    }

    let lateAutomation: Promise<unknown> | undefined
    const automation = manager.executePromptAutomation({
      workspaceId: workspace.id,
      workspaceRootPath: workspace.rootPath,
      prompt: 'test',
    }).catch(() => undefined)
    await started
    const result = await manager.removeWorkspace(workspace.id, hooks({
      freezeExternalAdmission: () => {
        lateAutomation = manager.executePromptAutomation({
          workspaceId: workspace.id,
          workspaceRootPath: workspace.rootPath,
          prompt: 'late',
        })
      },
    }))
    expect(result.code).toBe('active-background')
    expect(lateAutomation).toBeDefined()
    await expect(lateAutomation!).rejects.toBeInstanceOf(WorkspaceAdmissionError)
    finishCreate()
    await automation
  })

  it('deduplicates concurrent removals, detaches config last, and makes repeats idempotent', async () => {
    const manager = new SessionManager()
    const order: string[] = []
    let releaseExternal!: () => void
    const externalBarrier = new Promise<void>((resolve) => { releaseExternal = resolve })
    ;(manager as any).releaseWorkspaceResources = async () => {
      ;(manager as any).lifecycleFor(workspace.id).teardownStarted = true
      order.push('internal')
    }

    const removalHooks = hooks({
      freezeExternalAdmission: () => order.push('freeze'),
      hasExternalActivity: () => false,
      releaseExternalResources: async () => { order.push('external'); await externalBarrier },
      detachConfig: () => { order.push('detach'); return detachWorkspaceConfig(workspace.id) },
      cleanupCredentials: async () => { order.push('credentials') },
    })
    const first = manager.removeWorkspace(workspace.id, removalHooks)
    const second = manager.removeWorkspace(workspace.id, removalHooks)
    expect(second).toBe(first)
    await Promise.resolve()
    expect(order).toEqual(['freeze', 'internal', 'external'])
    releaseExternal()

    expect(await first).toEqual({ ok: true, code: 'success' })
    expect(await second).toEqual({ ok: true, code: 'success' })
    expect(order).toEqual(['freeze', 'internal', 'external', 'detach', 'credentials'])
    expect(await manager.removeWorkspace(workspace.id, removalHooks)).toEqual({ ok: true, code: 'already-removed' })
    expect(order.at(-1)).toBe('credentials')
  })

  it('keeps config attached after pre-detach or teardown failure and supports fail-forward retry', async () => {
    const preflightManager = new SessionManager()
    let detachCalls = 0
    const preflight = await preflightManager.removeWorkspace(workspace.id, hooks({
      freezeExternalAdmission: () => {},
      resumeExternalAdmission: () => {},
      hasExternalActivity: () => { throw new Error('oracle failed') },
      detachConfig: () => { detachCalls += 1; return true },
    }))
    expect(preflight).toEqual({ ok: false, code: 'teardown-failed', retryable: true })
    expect(detachCalls).toBe(0)
    expect(loadStoredConfig()?.workspaces).toHaveLength(1)

    const retryManager = new SessionManager()
    let attempts = 0
    const retryHooks = hooks({
      releaseExternalResources: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('late teardown failure')
      },
    })
    expect(await retryManager.removeWorkspace(workspace.id, retryHooks)).toEqual({ ok: false, code: 'teardown-failed', retryable: true })
    expect(loadStoredConfig()?.workspaces).toHaveLength(1)
    expect(() => retryManager.assertWorkspaceAdmission(workspace.id, 'background')).toThrow(WorkspaceAdmissionError)
    expect(await retryManager.removeWorkspace(workspace.id, retryHooks)).toEqual({ ok: true, code: 'success' })
    expect(attempts).toBe(2)
  })

  it('leaves admission closed and config attached when an idle runtime cannot be disposed', async () => {
    const manager = new SessionManager()
    const sessionId = 'runtime-failure'
    ;(manager as any).taskConductor = { hasNonTerminalRuns: () => false, releaseWorkspace: () => {} }
    ;(manager as any).persistSession = () => {}
    ;(manager as any).flushSession = async () => {}
    let disposalAttempts = 0
    const agent = {
      onRuntimeExit: null,
      setBackgroundEventSink: () => {},
      disposeRuntime: async () => {
        disposalAttempts += 1
        return disposalAttempts === 1
          ? {
              outcome: 'limited_observability' as const,
              observedExit: false,
              attemptedGraceful: true,
              forced: false,
              durationMs: 1,
              errorCode: 'runtime_dispose_failed' as const,
            }
          : {
              outcome: 'graceful' as const,
              observedExit: true,
              attemptedGraceful: true,
              forced: false,
              durationMs: 1,
            }
      },
    }
    ;(manager as any).sessions.set(sessionId, {
      id: sessionId,
      workspace,
      isProcessing: false,
      deleting: false,
      messageQueue: [],
      backgroundTaskRegistry: new Map(),
      backgroundTaskOutputs: new Map(),
      backgroundShellCommands: new Map(),
      authRetryInProgress: false,
      agent,
      nextRuntimeEpoch: 0,
    })

    expect(await manager.removeWorkspace(workspace.id, hooks())).toEqual({
      ok: false,
      code: 'teardown-failed',
      retryable: true,
    })
    expect(loadStoredConfig()?.workspaces).toHaveLength(1)
    expect(() => manager.assertWorkspaceAdmission(workspace.id, 'task')).toThrow(WorkspaceAdmissionError)
    expect((manager as any).sessions.get(sessionId).agent).toBe(agent)
    expect(await manager.removeWorkspace(workspace.id, hooks())).toEqual({ ok: true, code: 'success' })
    expect(disposalAttempts).toBe(2)
  })

  it('releases watchers, automation, task ownership, session timers/maps, and external pollers before detach', async () => {
    const manager = new SessionManager()
    const stopped: string[] = []
    const sessionId = 'session-idle'
    const deltaTimer = setTimeout(() => {}, 60_000)
    const retryTimer = setTimeout(() => {}, 60_000)
    const stopTimer = setTimeout(() => {}, 60_000)
    ;(manager as any).configWatchers.set(workspace.rootPath, { stop: () => stopped.push('watcher') })
    ;(manager as any).automationSystems.set(workspace.rootPath, { dispose: () => stopped.push('automation') })
    ;(manager as any).taskConductor = {
      hasNonTerminalRuns: () => false,
      releaseWorkspace: () => stopped.push('task'),
    }
    ;(manager as any).persistSession = () => {}
    ;(manager as any).flushSession = async () => {}
    ;(manager as any).disposeManagedAgentRuntime = async () => ({ outcome: 'graceful' })
    ;(manager as any).sessions.set(sessionId, {
      id: sessionId,
      workspace,
      isProcessing: false,
      deleting: false,
      messageQueue: [],
      backgroundTaskRegistry: new Map(),
      backgroundTaskOutputs: new Map([['task-output', {}]]),
      backgroundShellCommands: new Map(),
      authRetryInProgress: false,
      autoRetryTimer: retryTimer,
      stopTimer,
    })
    ;(manager as any).deltaFlushTimers.set(sessionId, deltaTimer)
    ;(manager as any).pendingDeltas.set(sessionId, { delta: 'x' })
    ;(manager as any).externalMetadataGuardTimers.set(sessionId, setTimeout(() => {}, 60_000))
    ;(manager as any).taskOutputIndex.set('task-output', sessionId)
    ;(manager as any).activeViewingSession.set(workspace.id, sessionId)
    let pollersReleased = false

    const result = await manager.removeWorkspace(workspace.id, hooks({
      releaseExternalResources: async () => { pollersReleased = true },
    }))

    expect(result).toEqual({ ok: true, code: 'success' })
    expect(stopped).toEqual(['watcher', 'automation', 'task'])
    expect(pollersReleased).toBe(true)
    expect((manager as any).sessions.has(sessionId)).toBe(false)
    expect((manager as any).deltaFlushTimers.has(sessionId)).toBe(false)
    expect((manager as any).pendingDeltas.has(sessionId)).toBe(false)
    expect((manager as any).externalMetadataGuardTimers.has(sessionId)).toBe(false)
    expect((manager as any).taskOutputIndex.has('task-output')).toBe(false)
    expect((manager as any).activeViewingSession.has(workspace.id)).toBe(false)
  })

  it('classifies required watch budget and never rolls config back after credential cleanup failure', async () => {
    const budgetManager = new SessionManager()
    const budgetResult = await budgetManager.removeWorkspace(workspace.id, hooks({
      hasExternalActivity: () => { const error = new Error('capacity'); (error as Error & { code: string }).code = 'required-watch-budget'; throw error },
    }))
    expect(budgetResult).toEqual({ ok: false, code: 'required-watch-budget', retryable: true })
    expect(loadStoredConfig()?.workspaces).toHaveLength(1)

    const credentialManager = new SessionManager()
    let cleanupAttempts = 0
    const credentialHooks = hooks({
      cleanupCredentials: async () => {
        cleanupAttempts += 1
        if (cleanupAttempts === 1) throw new Error('locked keychain')
      },
    })
    expect(await credentialManager.removeWorkspace(workspace.id, credentialHooks)).toEqual({
      ok: true,
      code: 'success',
      credentialCleanupPending: true,
    })
    expect(loadStoredConfig()?.workspaces).toEqual([])
    expect(await credentialManager.removeWorkspace(workspace.id, credentialHooks)).toEqual({ ok: true, code: 'already-removed' })
    expect(cleanupAttempts).toBe(2)
  })

  it('re-add resets removed lifecycle ownership with no stale admission counters', async () => {
    const manager = new SessionManager()
    expect(await manager.removeWorkspace(workspace.id, hooks())).toEqual({ ok: true, code: 'success' })
    saveConfig({ workspaces: [workspace], activeWorkspaceId: workspace.id, activeSessionId: null })

    expect((manager as any).activateWorkspaceLifecycle(workspace.id)).toBe(true)
    const lifecycle = (manager as any).lifecycleFor(workspace.id)
    expect(lifecycle.state).toBe('active')
    expect(lifecycle.inFlight).toEqual({ session: 0, task: 0, automation: 0, background: 0 })
    expect(() => manager.assertWorkspaceAdmission(workspace.id, 'task')).not.toThrow()
  })
})
