import { afterEach, beforeEach, describe, expect, it, spyOn, type Mock } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  getSessionFilePath,
  readSessionHeader,
  readSessionJsonl,
  sessionPersistenceQueue,
  writeSessionJsonl,
  type StoredSession,
} from '@craft-agent/shared/sessions'
import { ConfigWatcher } from '@craft-agent/shared/config'
import { SessionManager, createManagedSession } from './SessionManager.ts'

const refA = {
  connectionId: '123e4567-e89b-42d3-8456-426614174000',
  spaceId: 'aaaaaaaa-e89b-42d3-8456-426614174000',
}
const refB = {
  connectionId: '123e4567-e89b-42d3-8456-426614174000',
  spaceId: 'bbbbbbbb-e89b-42d3-8456-426614174000',
}

type PublicMemorySession = {
  name?: string
  sessionStatus?: string
  enabledMemorySpaceRefs?: Array<typeof refA>
  memoryWriteTargetRef?: typeof refA
  memorySelectionMode?: 'explicit'
}

describe('SessionManager external Memory reconciliation', () => {
  let workspaceRootPath: string
  let sessionId: string
  let sm: SessionManager
  let workspace: { id: string; name: string; rootPath: string; createdAt: number }
  let watcherStartSpy: Mock<typeof ConfigWatcher.prototype.start>

  beforeEach(() => {
    workspaceRootPath = mkdtempSync(join(tmpdir(), 'session-manager-memory-watch-'))
    sessionId = `memory-watch-${Math.random().toString(36).slice(2)}`
    workspace = {
      id: 'ws-memory-watch',
      name: 'Memory Watch',
      rootPath: workspaceRootPath,
      createdAt: 1,
    }
    sm = new SessionManager()
    // Exercise the real ConfigWatcher dispatch/debounce/header-read path without
    // allocating recursive OS watchers (which is nondeterministic under CI
    // inotify limits). notifyFileChange still runs the production watcher code.
    watcherStartSpy = spyOn(ConfigWatcher.prototype, 'start').mockImplementation(function (this: ConfigWatcher) {
      ;(this as unknown as { isRunning: boolean }).isRunning = true
    })
    // Keep this test focused on ConfigWatcher -> SessionManager production
    // reconciliation without starting an AutomationSystem scheduler.
    ;(sm as unknown as { automationSystems: Map<string, unknown> }).automationSystems.set(workspaceRootPath, {
      updateSessionMetadata: async () => {},
      dispose: () => {},
    })
  })

  afterEach(async () => {
    await sm.flushSession(sessionId).catch(() => {})
    sm.cleanup()
    watcherStartSpy.mockRestore()
    sessionPersistenceQueue.cancel(sessionId)
    rmSync(workspaceRootPath, { recursive: true, force: true })
  })

  function stored(selection: 'A' | 'B' | 'none' = 'A', overrides: Partial<StoredSession> = {}): StoredSession {
    const memory = selection === 'none'
      ? {}
      : {
          enabledMemorySpaceRefs: [selection === 'A' ? refA : refB],
          memoryWriteTargetRef: selection === 'A' ? refA : refB,
          memorySelectionMode: 'explicit' as const,
        }
    return {
      id: sessionId,
      workspaceRootPath,
      name: 'Session A',
      sessionStatus: 'todo',
      createdAt: 1,
      lastUsedAt: 1,
      messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
      ...memory,
      ...overrides,
    }
  }

  function seedManaged(initial: StoredSession): void {
    const filePath = getSessionFilePath(workspaceRootPath, sessionId)
    mkdirSync(dirname(filePath), { recursive: true })
    writeSessionJsonl(filePath, initial)
    const managed = createManagedSession(initial as never, workspace as never, { messagesLoaded: true })
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, managed)
    const header = readSessionHeader(filePath)!
    sessionPersistenceQueue.initializeBaseline(sessionId, header)
    sm.setupConfigWatcher(workspaceRootPath, workspace.id)
  }

  function current(): PublicMemorySession {
    return sm.getSessions(workspace.id).find(session => session.id === sessionId)! as PublicMemorySession
  }

  async function notifyAndWait(predicate: (session: PublicMemorySession) => boolean): Promise<void> {
    sm.notifyConfigFileChange(workspaceRootPath, `sessions/${sessionId}/session.jsonl`)
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      if (predicate(current())) return
      await Bun.sleep(25)
    }
    expect(predicate(current())).toBe(true)
  }

  it('applies a Memory-only external B update to runtime A -> B through the watch path', async () => {
    seedManaged(stored('A'))
    writeSessionJsonl(getSessionFilePath(workspaceRootPath, sessionId), stored('B'))

    await notifyAndWait(session => session.enabledMemorySpaceRefs?.[0]?.spaceId === refB.spaceId)

    expect(current().enabledMemorySpaceRefs).toEqual([refB])
    expect(current().memoryWriteTargetRef).toEqual(refB)
    expect(current().memorySelectionMode).toBe('explicit')
  })

  it('reconciles mixed metadata and Memory as one normalized external header', async () => {
    seedManaged(stored('A'))
    writeSessionJsonl(getSessionFilePath(workspaceRootPath, sessionId), stored('B', {
      name: 'Session B',
      sessionStatus: 'needs-review',
    }))

    await notifyAndWait(session => session.name === 'Session B' && session.enabledMemorySpaceRefs?.[0]?.spaceId === refB.spaceId)

    expect(current()).toMatchObject({
      name: 'Session B',
      sessionStatus: 'needs-review',
      enabledMemorySpaceRefs: [refB],
      memoryWriteTargetRef: refB,
      memorySelectionMode: 'explicit',
    })
  })

  it('clears all three runtime fields when the external header removes the selection', async () => {
    seedManaged(stored('A'))
    writeSessionJsonl(getSessionFilePath(workspaceRootPath, sessionId), stored('none'))

    await notifyAndWait(session => session.enabledMemorySpaceRefs === undefined)

    expect(current().enabledMemorySpaceRefs).toBeUndefined()
    expect(current().memoryWriteTargetRef).toBeUndefined()
    expect(current().memorySelectionMode).toBeUndefined()
  })

  it('quarantines a malformed external selection without leaving partial runtime residue', async () => {
    seedManaged(stored('A'))
    const validHeader = readSessionHeader(getSessionFilePath(workspaceRootPath, sessionId))!
    const malformed = {
      ...validHeader,
      enabledMemorySpaceRefs: [{ ...refB, injected: true }],
      memoryWriteTargetRef: refB,
      memorySelectionMode: 'explicit',
    }
    writeFileSync(getSessionFilePath(workspaceRootPath, sessionId), `${JSON.stringify(malformed)}\n`)

    await notifyAndWait(session => session.enabledMemorySpaceRefs === undefined)

    expect(current().enabledMemorySpaceRefs).toBeUndefined()
    expect(current().memoryWriteTargetRef).toBeUndefined()
    expect(current().memorySelectionMode).toBeUndefined()
  })

  it('a fresh manager persistence cannot re-persist stale local A over existing disk B', async () => {
    // No durable queue baseline is initialized: this simulates a fresh manager
    // receiving a stale local snapshot before its first persistence attempt.
    sessionPersistenceQueue.cancel(sessionId)
    const filePath = getSessionFilePath(workspaceRootPath, sessionId)
    mkdirSync(dirname(filePath), { recursive: true })
    writeSessionJsonl(filePath, stored('B', { name: 'Disk B' }))
    const staleA = stored('A', { name: 'Disk B' })
    const managed = createManagedSession(staleA as never, workspace as never, { messagesLoaded: true })
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, managed)

    await sm.renameSession(sessionId, 'stale local rename')
    await sm.flushSession(sessionId)

    const persisted = readSessionJsonl(filePath)!
    expect(persisted.enabledMemorySpaceRefs).toEqual([refB])
    expect(persisted.memoryWriteTargetRef).toEqual(refB)
    expect(persisted.memorySelectionMode).toBe('explicit')
    expect(persisted.name).toBe('Disk B')
    expect(readFileSync(filePath, 'utf8').trim().split('\n')).toHaveLength(1)
  })
})
