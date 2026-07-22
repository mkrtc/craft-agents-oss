import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  getSessionFilePath,
  writeSessionJsonl,
  type StoredSession,
} from '@craft-agent/shared/sessions'
import { SessionManager, createManagedSession } from './SessionManager.ts'

describe('custom group session ordering', () => {
  let tmpRoot: string
  let sm: SessionManager
  let emitted: unknown[]

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-custom-group-order-'))
    sm = new SessionManager()
    emitted = []
    sm.setEventSink((_channel: string, _target: unknown, event: unknown) => emitted.push(event))
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function workspace() {
    return {
      id: 'ws_test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    } as never
  }

  function seedSession(id: string, customGroupId?: string, customGroupOrder?: number) {
    const stored: StoredSession = {
      id,
      workspaceRootPath: tmpRoot,
      name: id,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      customGroupId,
      customGroupOrder,
      messages: [],
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 0,
        costUsd: 0,
      },
    } as StoredSession
    const filePath = getSessionFilePath(tmpRoot, id)
    mkdirSync(dirname(filePath), { recursive: true })
    writeSessionJsonl(filePath, stored)
    const managed = createManagedSession(stored as never, workspace(), { messagesLoaded: true })
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed as { customGroupId?: string; customGroupOrder?: number }
  }

  function readHeader(id: string): Record<string, unknown> {
    return JSON.parse(readFileSync(getSessionFilePath(tmpRoot, id), 'utf-8').split('\n')[0])
  }

  it('appends assignments to the end of the target custom group and clears order when ungrouped', async () => {
    seedSession('a', 'group-a', 0)
    seedSession('b', 'group-a', 1)
    const target = seedSession('c')

    await sm.setSessionCustomGroupId('c', 'group-a')

    expect(target.customGroupId).toBe('group-a')
    expect(target.customGroupOrder).toBe(2)
    expect(readHeader('c').customGroupOrder).toBe(2)
    expect(emitted).toContainEqual({
      type: 'session_metadata_changed',
      sessionId: 'c',
      changes: { customGroupId: 'group-a', customGroupOrder: 2 },
    })

    await sm.setSessionCustomGroupId('c', null)

    expect(target.customGroupId).toBeUndefined()
    expect(target.customGroupOrder).toBeUndefined()
    expect(readHeader('c').customGroupOrder).toBeUndefined()
  })

  it('moves sessions to a different group by appending unless an explicit order is supplied', async () => {
    const moved = seedSession('a', 'group-a', 0)
    seedSession('b', 'group-b', 4)

    await sm.setSessionCustomGroupId('a', 'group-b')
    expect(moved.customGroupId).toBe('group-b')
    expect(moved.customGroupOrder).toBe(5)

    await sm.setSessionCustomGroupId('a', 'group-a', 3)
    expect(moved.customGroupId).toBe('group-a')
    expect(moved.customGroupOrder).toBe(3)
  })

  it('reorders only sessions that belong to the same workspace and custom group', async () => {
    const a = seedSession('a', 'group-a', 0)
    const b = seedSession('b', 'group-a', 1)
    seedSession('c', 'group-b', 0)

    await sm.reorderCustomGroupSessions('a', 'group-a', ['b', 'a'])

    expect(b.customGroupOrder).toBe(0)
    expect(a.customGroupOrder).toBe(1)
    expect(readHeader('b').customGroupOrder).toBe(0)
    expect(readHeader('a').customGroupOrder).toBe(1)
    expect(emitted).toContainEqual({
      type: 'session_metadata_changed',
      sessionId: 'b',
      changes: { customGroupId: 'group-a', customGroupOrder: 0 },
    })

    await expect(sm.reorderCustomGroupSessions('a', 'group-a', ['a', 'c'])).rejects.toThrow('does not belong to custom group')
    await expect(sm.reorderCustomGroupSessions('a', 'group-a', ['missing'])).rejects.toThrow('not found')
  })
})
