import { afterEach, describe, it, expect } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { copyFile as fsCopyFile, open as fsOpen, rename as fsRename, unlink as fsUnlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionHeader, StoredSession } from '../types'
import { getHeaderMetadataSignature, mergeHeaderWithExternalMetadata, SessionPersistenceQueue, type SessionPersistenceFsAdapter } from '../persistence-queue'
import { getSessionFilePath } from '../storage'
import { MAX_SESSION_HEADER_BYTES, readSessionJsonl, writeSessionJsonl } from '../jsonl'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeHeader(overrides: Partial<SessionHeader> = {}): SessionHeader {
  return {
    id: 's1',
    workspaceRootPath: '~/.craft-agent/workspaces/ws',
    createdAt: 1,
    lastUsedAt: 2,
    messageCount: 0,
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      contextTokens: 0,
    },
    ...overrides,
  }
}

describe('session persistence header conflict helpers', () => {
  it('metadata signature ignores non-metadata fields', () => {
    const a = makeHeader({ name: 'A', lastUsedAt: 100 })
    const b = makeHeader({ name: 'A', lastUsedAt: 999, messageCount: 42 })

    expect(getHeaderMetadataSignature(a)).toBe(getHeaderMetadataSignature(b))
  })

  it('metadata signature changes when metadata changes', () => {
    const a = makeHeader({ name: 'A', labels: ['x'] })
    const b = makeHeader({ name: 'B', labels: ['x'] })

    expect(getHeaderMetadataSignature(a)).not.toBe(getHeaderMetadataSignature(b))
  })

  it('metadata signature changes when Memory selection changes', () => {
    const ref = { connectionId: '123e4567-e89b-42d3-8456-426614174000', spaceId: 'aaaaaaaa-e89b-42d3-8456-426614174000' }
    const a = makeHeader({ enabledMemorySpaceRefs: [ref], memorySelectionMode: 'explicit' })
    const b = makeHeader({ enabledMemorySpaceRefs: [ref], memoryWriteTargetRef: ref, memorySelectionMode: 'explicit' })

    expect(getHeaderMetadataSignature(a)).not.toBe(getHeaderMetadataSignature(b))
  })

  it('merge preserves external metadata while keeping local computed fields', () => {
    const local = makeHeader({
      name: 'Local Name',
      labels: ['local'],
      isFlagged: false,
      isPinned: false,
      sessionStatus: 'todo',
      permissionMode: 'allow-all',
      hasUnread: true,
      lastReadMessageId: 'm-local',
      projectId: 'project-local',
      kanbanColumn: 'todo',
      messageCount: 99,
      lastUsedAt: 500,
    })

    const disk = makeHeader({
      name: 'Disk Name',
      labels: ['disk'],
      isFlagged: true,
      isPinned: true,
      pinnedAt: 1234,
      sessionStatus: 'needs-review',
      permissionMode: 'safe',
      hasUnread: false,
      lastReadMessageId: 'm-disk',
      projectId: 'project-disk',
      kanbanColumn: 'done',
      messageCount: 1,
      lastUsedAt: 50,
    })

    const merged = mergeHeaderWithExternalMetadata(local, disk)

    expect(merged.name).toBe('Disk Name')
    expect(merged.labels).toEqual(['disk'])
    expect(merged.isFlagged).toBe(true)
    expect(merged.isPinned).toBe(true)
    expect(merged.pinnedAt).toBe(1234)
    expect(merged.sessionStatus).toBe('needs-review')
    expect(merged.permissionMode).toBe('safe')
    expect(merged.hasUnread).toBe(false)
    expect(merged.lastReadMessageId).toBe('m-disk')
    expect(merged.projectId).toBe('project-disk')
    expect(merged.kanbanColumn).toBe('done')

    // Local computed/runtime persistence fields remain local
    expect(merged.messageCount).toBe(99)
    expect(merged.lastUsedAt).toBe(500)
    merged.labels!.push('mutated')
    expect(disk.labels).toEqual(['disk'])
  })

  it('merge preserves external Memory selection while keeping local computed fields', () => {
    const local = makeHeader({
      enabledMemorySpaceRefs: [{ connectionId: '123e4567-e89b-42d3-8456-426614174000', spaceId: 'aaaaaaaa-e89b-42d3-8456-426614174000' }],
      memorySelectionMode: 'explicit',
      messageCount: 99,
    })
    const diskRef = { connectionId: '123e4567-e89b-42d3-8456-426614174000', spaceId: 'bbbbbbbb-e89b-42d3-8456-426614174000' }
    const disk = makeHeader({
      enabledMemorySpaceRefs: [diskRef],
      memoryWriteTargetRef: diskRef,
      memorySelectionMode: 'explicit',
      messageCount: 1,
    })

    const merged = mergeHeaderWithExternalMetadata(local, disk)

    expect(merged.enabledMemorySpaceRefs).toEqual([diskRef])
    expect(merged.memoryWriteTargetRef).toEqual(diskRef)
    expect(merged.memorySelectionMode).toBe('explicit')
    expect(merged.messageCount).toBe(99)

    // The merge boundary must be pure: callers may mutate the result without
    // mutating watcher-owned disk header arrays or nested refs.
    merged.enabledMemorySpaceRefs![0]!.spaceId = 'cccccccc-e89b-42d3-8456-426614174000'
    merged.enabledMemorySpaceRefs!.push({ ...local.enabledMemorySpaceRefs![0]! })
    merged.memoryWriteTargetRef!.spaceId = 'dddddddd-e89b-42d3-8456-426614174000'
    expect(disk.enabledMemorySpaceRefs).toEqual([diskRef])
    expect(disk.memoryWriteTargetRef).toEqual(diskRef)
  })

  it('does not replace an established baseline while a local mutation is pending', () => {
    const queue = new SessionPersistenceQueue(60_000)
    queue.initializeBaseline('active-baseline', makeHeader({ name: 'A' }))
    queue.enqueue({
      id: 'active-baseline',
      workspaceRootPath: '/tmp/not-written',
      name: 'B',
      createdAt: 1,
      lastUsedAt: 1,
      messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    })
    queue.initializeBaseline('active-baseline', makeHeader({ name: 'external C' }))

    expect(queue.getLastWrittenSignature('active-baseline')).toBe(
      getHeaderMetadataSignature(makeHeader({ name: 'A' })),
    )
    queue.cancel('active-baseline')
  })

  it('queued writes preserve a valid external Memory selection change', async () => {
    const workspaceRootPath = mkdtempSync(join(tmpdir(), 'session-memory-queue-'))
    tempDirs.push(workspaceRootPath)
    const session: StoredSession = {
      id: 'queue-merge',
      workspaceRootPath,
      createdAt: 1,
      lastUsedAt: 1,
      messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    }
    const queue = new SessionPersistenceQueue(1)
    queue.enqueue(session)
    await queue.flush(session.id)

    const filePath = getSessionFilePath(workspaceRootPath, session.id)
    const external = readSessionJsonl(filePath)!
    const ref = { connectionId: '123e4567-e89b-42d3-8456-426614174000', spaceId: 'aaaaaaaa-e89b-42d3-8456-426614174000' }
    external.enabledMemorySpaceRefs = [ref]
    external.memoryWriteTargetRef = ref
    external.memorySelectionMode = 'explicit'
    writeSessionJsonl(filePath, external)

    queue.enqueue(session)
    await queue.flush(session.id)

    const persisted = readSessionJsonl(filePath)!
    expect(persisted.enabledMemorySpaceRefs).toEqual([ref])
    expect(persisted.memoryWriteTargetRef).toEqual(ref)
    expect(persisted.memorySelectionMode).toBe('explicit')
    queue.cancel(session.id)
  })

  it('fresh queue preserves external disk Memory selection over stale local state', async () => {
    const workspaceRootPath = mkdtempSync(join(tmpdir(), 'session-memory-fresh-'))
    tempDirs.push(workspaceRootPath)
    const refA = { connectionId: '123e4567-e89b-42d3-8456-426614174000', spaceId: 'aaaaaaaa-e89b-42d3-8456-426614174000' }
    const refB = { connectionId: '123e4567-e89b-42d3-8456-426614174000', spaceId: 'bbbbbbbb-e89b-42d3-8456-426614174000' }
    const disk: StoredSession = { id: 'fresh', workspaceRootPath, createdAt: 1, lastUsedAt: 1, messages: [], tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 }, enabledMemorySpaceRefs: [refB], memoryWriteTargetRef: refB, memorySelectionMode: 'explicit' }
    const filePath = getSessionFilePath(workspaceRootPath, disk.id)
    mkdirSync(join(workspaceRootPath, 'sessions', disk.id), { recursive: true })
    writeSessionJsonl(filePath, disk)
    const queue = new SessionPersistenceQueue(1)
    const stale = { ...disk, enabledMemorySpaceRefs: [refA], memoryWriteTargetRef: refA }
    queue.enqueue(stale)
    await queue.flush(stale.id)
    const persisted = readSessionJsonl(filePath)!
    expect(persisted.enabledMemorySpaceRefs).toEqual([refB])
    expect(persisted.memoryWriteTargetRef).toEqual(refB)
  })

  it('surfaces a deterministic fsync failure, retains durable baseline and pending data, then retries B', async () => {
    const workspaceRootPath = mkdtempSync(join(tmpdir(), 'session-memory-fault-'))
    tempDirs.push(workspaceRootPath)
    const sessionId = 'fault-retry'
    const filePath = getSessionFilePath(workspaceRootPath, sessionId)
    mkdirSync(join(workspaceRootPath, 'sessions', sessionId), { recursive: true })
    const sessionA: StoredSession = {
      id: sessionId,
      workspaceRootPath,
      name: 'A',
      createdAt: 1,
      lastUsedAt: 1,
      messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    }
    writeSessionJsonl(filePath, sessionA)
    const headerA = readSessionJsonl(filePath)!
    let failSync = true
    const fs: SessionPersistenceFsAdapter = {
      open: async (path, flags) => {
        const handle = await fsOpen(path, flags)
        return {
          writeFile: async (data, encoding) => { await handle.writeFile(data, encoding) },
          sync: async () => {
            if (failSync) throw Object.assign(new Error('injected fsync failure'), { code: 'EIO' })
            await handle.sync()
          },
          close: async () => { await handle.close() },
        }
      },
      rename: fsRename,
      unlink: fsUnlink,
    }
    const queue = new SessionPersistenceQueue(60_000, fs)
    queue.initializeBaseline(sessionId, makeHeader({ name: headerA.name }))
    const signatureA = queue.getLastWrittenSignature(sessionId)
    queue.enqueue({ ...sessionA, name: 'B' })

    await expect(queue.flush(sessionId)).rejects.toThrow('injected fsync failure')
    expect(readSessionJsonl(filePath)?.name).toBe('A')
    expect(queue.getLastWrittenSignature(sessionId)).toBe(signatureA)
    expect(queue.hasPending(sessionId)).toBe(true)

    failSync = false
    await queue.flush(sessionId)
    expect(readSessionJsonl(filePath)?.name).toBe('B')
    expect(queue.getLastWrittenSignature(sessionId)).toBe(
      getHeaderMetadataSignature(makeHeader({ name: 'B' })),
    )
    expect(queue.hasPending(sessionId)).toBe(false)
    expect(existsSync(`${filePath}.tmp`)).toBe(false)
  })

  it('rejects an oversized queued write before replacing valid disk data or creating a temp file', async () => {
    const workspaceRootPath = mkdtempSync(join(tmpdir(), 'session-memory-queue-cap-'))
    tempDirs.push(workspaceRootPath)
    const sessionId = 'queue-cap'
    const filePath = getSessionFilePath(workspaceRootPath, sessionId)
    mkdirSync(join(workspaceRootPath, 'sessions', sessionId), { recursive: true })
    const valid: StoredSession = {
      id: sessionId,
      workspaceRootPath,
      name: 'valid A',
      createdAt: 1,
      lastUsedAt: 1,
      messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    }
    writeSessionJsonl(filePath, valid)
    const queue = new SessionPersistenceQueue(60_000)
    queue.enqueue({ ...valid, name: 'oversized B', transferredSessionSummary: 'x'.repeat(MAX_SESSION_HEADER_BYTES) })

    await expect(queue.flush(sessionId)).rejects.toThrow(
      `Session header exceeds ${MAX_SESSION_HEADER_BYTES} byte limit`,
    )
    expect(readSessionJsonl(filePath)?.name).toBe('valid A')
    expect(existsSync(`${filePath}.tmp`)).toBe(false)
    expect(queue.hasPending(sessionId)).toBe(true)
    queue.cancel(sessionId)
  })

  it('restores old A on queued Windows fallback rename failure, retains pending B, then retries', async () => {
    const workspaceRootPath = mkdtempSync(join(tmpdir(), 'session-memory-rename-fault-'))
    tempDirs.push(workspaceRootPath)
    const sessionId = 'rename-fault'
    const filePath = getSessionFilePath(workspaceRootPath, sessionId)
    const tmpFile = `${filePath}.tmp`
    const backupFile = `${filePath}.bak`
    mkdirSync(join(workspaceRootPath, 'sessions', sessionId), { recursive: true })
    const sessionA: StoredSession = {
      id: sessionId,
      workspaceRootPath,
      name: 'A',
      createdAt: 1,
      lastUsedAt: 1,
      messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    }
    writeSessionJsonl(filePath, sessionA)
    let tmpTargetAttempts = 0
    let failRenameRestore = true
    const fs: SessionPersistenceFsAdapter = {
      open: async (path, flags) => {
        const handle = await fsOpen(path, flags)
        return {
          writeFile: async (data, encoding) => { await handle.writeFile(data, encoding) },
          sync: async () => { await handle.sync() },
          close: async () => { await handle.close() },
        }
      },
      rename: async (oldPath, newPath) => {
        if (oldPath === tmpFile && newPath === filePath) {
          tmpTargetAttempts++
          if (tmpTargetAttempts === 1) throw Object.assign(new Error('destination exists'), { code: 'EEXIST' })
          if (tmpTargetAttempts === 2) throw Object.assign(new Error('injected replacement failure'), { code: 'EIO' })
        }
        if (oldPath === backupFile && newPath === filePath && failRenameRestore) {
          failRenameRestore = false
          throw Object.assign(new Error('injected restore rename failure'), { code: 'EIO' })
        }
        await fsRename(oldPath, newPath)
      },
      unlink: fsUnlink,
      copyFile: fsCopyFile,
    }
    const queue = new SessionPersistenceQueue(60_000, fs)
    queue.initializeBaseline(sessionId, makeHeader({ name: 'A' }))
    const signatureA = queue.getLastWrittenSignature(sessionId)
    queue.enqueue({ ...sessionA, name: 'B' })

    await expect(queue.flush(sessionId)).rejects.toThrow('injected replacement failure')
    expect(readSessionJsonl(filePath)?.name).toBe('A')
    expect(queue.getLastWrittenSignature(sessionId)).toBe(signatureA)
    expect(queue.hasPending(sessionId)).toBe(true)
    expect(existsSync(tmpFile)).toBe(false)
    expect(existsSync(backupFile)).toBe(false)

    await queue.flush(sessionId)
    expect(readSessionJsonl(filePath)?.name).toBe('B')
    expect(queue.hasPending(sessionId)).toBe(false)
    expect(existsSync(tmpFile)).toBe(false)
    expect(existsSync(backupFile)).toBe(false)
  })

  it('serializes a timer write with a concurrent flush and coalesces to newest C after failure', async () => {
    const workspaceRootPath = mkdtempSync(join(tmpdir(), 'session-memory-coalesce-fault-'))
    tempDirs.push(workspaceRootPath)
    const sessionId = 'fault-coalesce'
    const filePath = getSessionFilePath(workspaceRootPath, sessionId)
    mkdirSync(join(workspaceRootPath, 'sessions', sessionId), { recursive: true })
    const sessionA: StoredSession = {
      id: sessionId,
      workspaceRootPath,
      name: 'A',
      createdAt: 1,
      lastUsedAt: 1,
      messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    }
    writeSessionJsonl(filePath, sessionA)

    let enterSync!: () => void
    const syncEntered = new Promise<void>(resolve => { enterSync = resolve })
    let releaseSync!: () => void
    const syncReleased = new Promise<void>(resolve => { releaseSync = resolve })
    let failNextSync = true
    let activeHandles = 0
    let maxActiveHandles = 0
    const fs: SessionPersistenceFsAdapter = {
      open: async (path, flags) => {
        const handle = await fsOpen(path, flags)
        activeHandles++
        maxActiveHandles = Math.max(maxActiveHandles, activeHandles)
        return {
          writeFile: async (data, encoding) => { await handle.writeFile(data, encoding) },
          sync: async () => {
            if (failNextSync) {
              enterSync()
              await syncReleased
              failNextSync = false
              throw Object.assign(new Error('injected coalescing failure'), { code: 'EIO' })
            }
            await handle.sync()
          },
          close: async () => {
            try { await handle.close() } finally { activeHandles-- }
          },
        }
      },
      rename: fsRename,
      unlink: fsUnlink,
    }
    const queue = new SessionPersistenceQueue(1, fs)
    queue.initializeBaseline(sessionId, makeHeader({ name: 'A' }))
    const signatureA = queue.getLastWrittenSignature(sessionId)
    queue.enqueue({ ...sessionA, name: 'B' })
    await syncEntered // B started from the debounce timer.
    queue.enqueue({ ...sessionA, name: 'C' })
    const concurrentFlush = queue.flush(sessionId)
    await Bun.sleep(5)
    expect(maxActiveHandles).toBe(1)
    releaseSync()

    await expect(concurrentFlush).rejects.toThrow('injected coalescing failure')
    expect(readSessionJsonl(filePath)?.name).toBe('A')
    expect(queue.getLastWrittenSignature(sessionId)).toBe(signatureA)
    expect(queue.hasPending(sessionId)).toBe(true)

    await queue.flush(sessionId)
    expect(readSessionJsonl(filePath)?.name).toBe('C')
    expect(queue.hasPending(sessionId)).toBe(false)
    expect(maxActiveHandles).toBe(1)
  })
})
