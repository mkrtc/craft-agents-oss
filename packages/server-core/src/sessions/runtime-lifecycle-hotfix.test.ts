import { afterEach, describe, expect, it, jest } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager, createManagedSession } from './SessionManager'
import { sessionPersistenceQueue } from '@craft-agent/shared/sessions'

interface Calls {
  dispose: number
  poolStop: number
  mcpDisconnect: number
  forceAbort: number
}

const roots: string[] = []
const sessionIds: string[] = []

afterEach(() => {
  jest.useRealTimers()
  for (const id of sessionIds.splice(0)) sessionPersistenceQueue.cancel(id)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeManaged(sm: SessionManager, id: string, workspaceId = 'ws-a') {
  const rootPath = mkdtempSync(join(tmpdir(), 'runtime-hotfix-'))
  roots.push(rootPath)
  sessionIds.push(id)
  const managed = createManagedSession(
    { id, messagesLoaded: true },
    { id: workspaceId, slug: workspaceId, name: workspaceId, rootPath, createdAt: Date.now() },
    { messagesLoaded: true },
  ) as any
  ;(sm as any).sessions.set(id, managed)
  return managed
}

function attachRuntime(sm: SessionManager, managed: any, calls: Calls) {
  managed.agent = {
    onRuntimeExit: null,
    setBackgroundEventSink: () => {},
    forceAbort: () => { calls.forceAbort++ },
    disposeRuntime: async () => {
      calls.dispose++
      return {
        outcome: 'graceful', observedExit: true, attemptedGraceful: true,
        forced: false, durationMs: 0, provider: 'pi',
      }
    },
  }
  managed.poolServer = { stop: async () => { calls.poolStop++ } }
  managed.mcpPool = { disconnectAll: async () => { calls.mcpDisconnect++ } }
  return (sm as any).ensureRuntimeGeneration(managed)
}

function calls(): Calls {
  return { dispose: 0, poolStop: 0, mcpDisconnect: 0, forceAbort: 0 }
}

describe('SessionManager runtime lifecycle hotfix', () => {
  it('auth failure never raw-nulls or auto-replays and exact bundle disposes once', async () => {
    const sm = new SessionManager()
    const managed = makeManaged(sm, 'auth')
    const c = calls()
    const generation = attachRuntime(sm, managed, c)
    ;(sm as any).reinitializeAuth = async () => {}
    const emitted: any[] = []
    sm.setEventSink((_channel: string, _target: unknown, event: unknown) => emitted.push(event))

    managed.isProcessing = true
    managed.processingGeneration = 1
    const turn = (sm as any).beginTurn(managed)
    turn.agent = managed.agent
    turn.runtimeEpoch = generation.epoch

    await (sm as any).processEvent(managed, {
      type: 'typed_error',
      error: {
        code: 'invalid_api_key',
        title: 'Invalid API Key',
        message: 'expired',
        actions: [],
        canRetry: false,
      },
    }, turn)

    expect(managed.agent).toBe(generation.agent)
    expect(turn.retireRuntimeAfterTurn).toBe('replacement')
    expect(managed.runtimeQueuePaused).toBe(true)
    expect(managed.messages.filter((message: any) => message.errorCode === 'invalid_api_key')).toEqual([
      expect.objectContaining({ errorCanRetry: true }),
    ])
    expect(emitted.some((event) => event?.type === 'typed_error' && event.error?.canRetry === true)).toBe(true)

    await Promise.all([
      (sm as any).disposeManagedAgentRuntime(managed, 'replacement', generation),
      (sm as any).disposeManagedAgentRuntime(managed, 'replacement', generation),
    ])

    expect(c).toMatchObject({ dispose: 1, poolStop: 1, mcpDisconnect: 1 })
    expect(managed.agent).toBeNull()
  })

  it('evicts global cross-workspace idle LRU by cap/TTL and skips permission/background protection', async () => {
    const sm = new SessionManager()
    Object.assign((sm as any).runtimeLifecycleConfig, { retainedCap: 2, idleTtlMs: 1_000 })
    const now = Date.now()
    const entries = Array.from({ length: 5 }, (_, index) => {
      const managed = makeManaged(sm, `idle-${index}`, index % 2 ? 'ws-b' : 'ws-a')
      const c = calls()
      attachRuntime(sm, managed, c)
      managed.runtimeIdleSince = now - (500 - index)
      return { managed, c }
    })

    entries[3].managed.backgroundTaskRegistry.set('task', {
      taskId: 'task', startTime: now, status: 'running',
    })
    ;(sm as any).pendingPermissionRequests.set('permission', { sessionId: entries[4].managed.id })

    await sm.reapIdleRuntimes(now)
    expect(entries.filter(({ c }) => c.dispose === 1)).toHaveLength(1)
    expect(entries[3].c.dispose).toBe(0)
    expect(entries[4].c.dispose).toBe(0)

    entries[3].managed.backgroundTaskRegistry.get('task').status = 'completed'
    ;(sm as any).pendingPermissionRequests.clear()
    await sm.reapIdleRuntimes(now + 2_000)
    expect(entries.every(({ c }) => c.dispose === 1)).toBe(true)
  })

  it('bounds a deterministic 50-runtime sequential-session stress fixture to retained cap 8', async () => {
    const sm = new SessionManager()
    Object.assign((sm as any).runtimeLifecycleConfig, { retainedCap: 8, idleTtlMs: 60_000 })
    const now = Date.now()
    const all = Array.from({ length: 50 }, (_, index) => {
      const managed = makeManaged(sm, `stress-${index}`, `ws-${index % 3}`)
      const c = calls()
      attachRuntime(sm, managed, c)
      managed.runtimeIdleSince = now - index
      return { managed, c }
    })

    await sm.reapIdleRuntimes(now)
    expect(all.reduce((sum, { c }) => sum + c.dispose, 0)).toBe(42)
    expect(all.filter(({ managed }) => managed.runtimeGeneration?.state === 'ready')).toHaveLength(8)
  })

  it('drops stale old turn events/terminal calls without touching the replacement turn', async () => {
    const sm = new SessionManager()
    const managed = makeManaged(sm, 'stale')
    const c = calls()
    attachRuntime(sm, managed, c)
    managed.isProcessing = true
    managed.processingGeneration = 1
    const oldTurn = (sm as any).beginTurn(managed)
    oldTurn.agent = managed.agent

    managed.processingGeneration = 2
    const replacementTurn = (sm as any).beginTurn(managed)
    replacementTurn.agent = managed.agent

    await (sm as any).processEvent(managed, { type: 'text_delta', text: 'late' }, oldTurn)
    await (sm as any).onProcessingStopped(managed.id, 'complete', oldTurn)

    expect(managed.streamingText).toBe('')
    expect(managed.isProcessing).toBe(true)
    expect(managed.activeTurn).toBe(replacementTurn)
  })

  it('unexpected exit terminalizes once, clears processing, pauses FIFO, and retires exact runtime', async () => {
    const sm = new SessionManager()
    const managed = makeManaged(sm, 'crash')
    const c = calls()
    const generation = attachRuntime(sm, managed, c)
    managed.isProcessing = true
    managed.processingGeneration = 1
    const turn = (sm as any).beginTurn(managed)
    turn.agent = managed.agent
    turn.runtimeEpoch = generation.epoch
    managed.backgroundTaskRegistry.set('running-task', {
      taskId: 'running-task', startTime: Date.now(), status: 'running',
    })

    await Promise.all([
      (sm as any).handleRuntimeFailure(managed, generation, managed.agent, 'crash', turn),
      (sm as any).handleRuntimeFailure(managed, generation, managed.agent, 'crash', turn),
    ])

    expect(managed.isProcessing).toBe(false)
    expect(managed.runtimeQueuePaused).toBe(true)
    expect(managed.messages.filter((message: any) => message.errorCode === 'runtime_backend_crashed')).toHaveLength(1)
    expect(managed.backgroundTaskRegistry.get('running-task').status).toBe('orphaned')
    expect(c.dispose).toBe(1)
  })

  it('ordinary silence timeout is suppressed during typed permission protection', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-07-15T15:21:00.000Z'))
    const sm = new SessionManager()
    Object.assign((sm as any).runtimeLifecycleConfig, {
      silenceTimeoutMs: 10,
      protectedLeaseMs: 100,
    })
    const managed = makeManaged(sm, 'permission-watchdog')
    const c = calls()
    const generation = attachRuntime(sm, managed, c)
    managed.isProcessing = true
    managed.processingGeneration = 1
    const turn = (sm as any).beginTurn(managed)
    turn.agent = managed.agent
    turn.runtimeEpoch = generation.epoch
    turn.phase = 'streaming'
    ;(sm as any).protectTurn(managed, 'permission')

    jest.advanceTimersByTime(20)
    await Promise.resolve()
    expect(c.dispose).toBe(0)
    expect(managed.isProcessing).toBe(true)

    jest.advanceTimersByTime(80)
    await Promise.resolve()
    await Promise.resolve()
    expect(c.dispose).toBe(1)
    expect(managed.messages.filter((message: any) => message.errorCode === 'runtime_watchdog_timeout')).toHaveLength(1)
  })

  it('watchdog produces one retryable timeout terminal and delete awaits the entire exact bundle', async () => {
    const sm = new SessionManager()
    const watchdogManaged = makeManaged(sm, 'watchdog')
    const watchdogCalls = calls()
    const watchdogGeneration = attachRuntime(sm, watchdogManaged, watchdogCalls)
    watchdogManaged.isProcessing = true
    watchdogManaged.processingGeneration = 1
    const turn = (sm as any).beginTurn(watchdogManaged)
    turn.agent = watchdogManaged.agent
    turn.runtimeEpoch = watchdogGeneration.epoch

    await (sm as any).handleRuntimeFailure(
      watchdogManaged,
      watchdogGeneration,
      watchdogManaged.agent,
      'watchdog',
      turn,
    )
    expect(watchdogManaged.messages.filter((message: any) => message.errorCode === 'runtime_watchdog_timeout')).toHaveLength(1)
    expect(watchdogCalls.dispose).toBe(1)

    const deleteManaged = makeManaged(sm, 'delete')
    const deleteCalls = calls()
    attachRuntime(sm, deleteManaged, deleteCalls)
    await sm.deleteSession(deleteManaged.id)
    expect(deleteCalls).toMatchObject({ dispose: 1, poolStop: 1, mcpDisconnect: 1 })
    expect((sm as any).sessions.has(deleteManaged.id)).toBe(false)
  })

  it('cancels and awaits every active turn before terminal shutdown continues', async () => {
    const sm = new SessionManager()
    const entries = ['active-a', 'active-b'].map((id) => {
      const managed = makeManaged(sm, id)
      const c = calls()
      const generation = attachRuntime(sm, managed, c)
      managed.isProcessing = true
      managed.processingGeneration = 1
      const turn = (sm as any).beginTurn(managed)
      turn.agent = managed.agent
      turn.runtimeEpoch = generation.epoch
      managed.messages.push({ id: `${id}-queued`, role: 'user', content: 'later', timestamp: 1 })
      managed.messageQueue.push({ message: 'later', messageId: `${id}-queued` })

      managed.agent.forceAbort = () => {
        c.forceAbort++
        queueMicrotask(() => {
          void (async () => {
            await (sm as any).onProcessingStopped(id, 'interrupted', turn)
            await (sm as any).disposeManagedAgentRuntime(managed, 'manual', generation)
          })()
        })
      }
      return { managed, c }
    })

    const cancellation = sm.cancelAllProcessingForShutdown({
      deadline: Date.now() + 2_000,
      graceMs: 250,
    })

    // Admission closes synchronously, before cancellation awaits any backend.
    expect(() => (sm as any).assertRuntimeAdmission()).toThrow('shutting down')
    const result = await cancellation

    expect(result).toEqual({ targeted: 2, cancelled: 2, forced: 0, failures: [] })
    for (const { managed, c } of entries) {
      expect(managed.isProcessing).toBe(false)
      expect(managed.messageQueue).toEqual([])
      expect(managed.messages.some((message: any) => message.content === 'later')).toBe(false)
      expect(managed.messages.some((message: any) => message.content === 'Response interrupted')).toBe(true)
      expect(c).toMatchObject({ forceAbort: 1, dispose: 1, poolStop: 1, mcpDisconnect: 1 })
    }
  })

  it('forces exact runtime retirement after bounded cancellation grace', async () => {
    const sm = new SessionManager()
    const managed = makeManaged(sm, 'unresponsive')
    const c = calls()
    const generation = attachRuntime(sm, managed, c)
    managed.isProcessing = true
    managed.processingGeneration = 1
    const turn = (sm as any).beginTurn(managed)
    turn.agent = managed.agent
    turn.runtimeEpoch = generation.epoch

    const result = await sm.cancelAllProcessingForShutdown({
      deadline: Date.now() + 2_000,
      graceMs: 0,
    })

    expect(result).toEqual({ targeted: 1, cancelled: 1, forced: 1, failures: [] })
    expect(managed.isProcessing).toBe(false)
    expect(c).toMatchObject({ forceAbort: 1, dispose: 1, poolStop: 1, mcpDisconnect: 1 })
  })

  it('closes admission and returns immediately when no sessions are active', async () => {
    const sm = new SessionManager()
    const result = await sm.cancelAllProcessingForShutdown({ deadline: Date.now() + 100, graceMs: 0 })
    expect(result).toEqual({ targeted: 0, cancelled: 0, forced: 0, failures: [] })
    expect(() => (sm as any).assertRuntimeAdmission()).toThrow('shutting down')
  })

  it('disposes partial construction and cleanup is same-promise, parallel, and closes admission', async () => {
    const sm = new SessionManager()
    const partial = makeManaged(sm, 'partial')
    const partialCalls = calls()
    const partialGeneration = attachRuntime(sm, partial, partialCalls)
    partialGeneration.state = 'creating'
    await (sm as any).disposeManagedAgentRuntime(partial, 'construction_failed', partialGeneration)
    expect(partialCalls).toMatchObject({ dispose: 1, poolStop: 1, mcpDisconnect: 1 })

    const starts: string[] = []
    const releases: Array<() => void> = []
    const shutdownCalls: Calls[] = []
    for (const id of ['shutdown-a', 'shutdown-b']) {
      const managed = makeManaged(sm, id)
      const c = calls()
      shutdownCalls.push(c)
      managed.agent = {
        onRuntimeExit: null,
        setBackgroundEventSink: () => {},
        forceAbort: () => {},
        disposeRuntime: async () => {
          starts.push(id)
          await new Promise<void>((resolve) => releases.push(resolve))
          c.dispose++
          return { outcome: 'graceful', observedExit: true, attemptedGraceful: true, forced: false, durationMs: 0 }
        },
      }
      managed.poolServer = { stop: async () => { c.poolStop++ } }
      managed.mcpPool = { disconnectAll: async () => { c.mcpDisconnect++ } }
      ;(sm as any).ensureRuntimeGeneration(managed)
    }

    const shutdown = sm.cleanup({ skipFlush: true, deadline: Date.now() + 5_000 })
    const duplicate = sm.cleanup({ skipFlush: true, deadline: Date.now() + 5_000 })
    expect(duplicate).toBe(shutdown)
    await Promise.resolve()
    expect(starts.sort()).toEqual(['shutdown-a', 'shutdown-b'])
    for (const release of releases) release()
    await shutdown
    expect(shutdownCalls.every((c) => c.dispose === 1 && c.poolStop === 1 && c.mcpDisconnect === 1)).toBe(true)
    expect(() => (sm as any).assertRuntimeAdmission()).toThrow('shutting down')
  })
})
