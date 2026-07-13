import { afterEach, describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionHeader, StoredSession } from '../types'
import { getHeaderMetadataSignature, mergeHeaderWithExternalMetadata, SessionPersistenceQueue } from '../persistence-queue'
import { getSessionFilePath } from '../storage'
import { readSessionJsonl, writeSessionJsonl } from '../jsonl'

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

    // Local computed/runtime persistence fields remain local
    expect(merged.messageCount).toBe(99)
    expect(merged.lastUsedAt).toBe(500)
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
    require('node:fs').mkdirSync(join(workspaceRootPath, 'sessions', disk.id), { recursive: true })
    writeSessionJsonl(filePath, disk)
    const queue = new SessionPersistenceQueue(1)
    const stale = { ...disk, enabledMemorySpaceRefs: [refA], memoryWriteTargetRef: refA }
    queue.enqueue(stale)
    await queue.flush(stale.id)
    const persisted = readSessionJsonl(filePath)!
    expect(persisted.enabledMemorySpaceRefs).toEqual([refB])
    expect(persisted.memoryWriteTargetRef).toEqual(refB)
  })
})
