import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  getSessionFilePath,
  loadSession,
  saveSession,
  listSessions,
  sessionPersistenceQueue,
  updateSessionMetadata,
} from '../storage.ts'
import { readSessionJsonl, writeSessionJsonl } from '../jsonl.ts'
import type { StoredSession } from '../types.ts'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function seed(name = 'A'): { workspace: string; session: StoredSession; filePath: string } {
  const workspace = mkdtempSync(join(tmpdir(), 'session-baseline-'))
  tempDirs.push(workspace)
  const session: StoredSession = {
    id: `baseline-${Math.random().toString(36).slice(2)}`,
    workspaceRootPath: workspace,
    name,
    createdAt: 1,
    lastUsedAt: 1,
    messages: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
  }
  const filePath = getSessionFilePath(workspace, session.id)
  mkdirSync(dirname(filePath), { recursive: true })
  writeSessionJsonl(filePath, session)
  sessionPersistenceQueue.cancel(session.id)
  return { workspace, session, filePath }
}

describe('authoritative load baselines', () => {
  it('preserves the first load -> modify -> save update', async () => {
    const { workspace, session, filePath } = seed()
    const loaded = loadSession(workspace, session.id)!
    loaded.name = 'B'

    await saveSession(loaded)

    expect(readSessionJsonl(filePath)?.name).toBe('B')
    sessionPersistenceQueue.cancel(session.id)
  })

  it('detects an external change even if a concurrent list scan refreshed the global baseline', async () => {
    const { workspace, session, filePath } = seed()
    const loaded = loadSession(workspace, session.id)!
    writeSessionJsonl(filePath, { ...session, name: 'external B' })
    listSessions(workspace) // observes B after the loaded object captured A
    loaded.name = 'local C'

    await saveSession(loaded)

    expect(readSessionJsonl(filePath)?.name).toBe('external B')
    expect(loaded.name).toBe('external B')
    loaded.labels = ['second local update']
    await saveSession(loaded)
    expect(readSessionJsonl(filePath)).toMatchObject({
      name: 'external B',
      labels: ['second local update'],
    })
    sessionPersistenceQueue.cancel(session.id)
  })

  it('preserves the first updateSessionMetadata mutation', async () => {
    const { workspace, session, filePath } = seed()

    await updateSessionMetadata(workspace, session.id, {
      name: 'B',
      sessionStatus: 'needs-review',
      labels: ['audit-fixed'],
    })

    expect(readSessionJsonl(filePath)).toMatchObject({
      name: 'B',
      sessionStatus: 'needs-review',
      labels: ['audit-fixed'],
    })
    sessionPersistenceQueue.cancel(session.id)
  })
})
