import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSession, loadSession, sessionPersistenceQueue } from '../storage.ts'

const tempDirs: string[] = []
const memoryRef = {
  connectionId: '123e4567-e89b-42d3-a456-426614174000',
  spaceId: 'aaaaaaaa-e89b-42d3-8456-426614174000',
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('initial session routing persistence', () => {
  test('persists explicit continuation routing and context before the first turn', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'session-continuation-'))
    tempDirs.push(workspace)

    const created = await createSession(workspace, {
      model: 'claude-sonnet',
      thinkingLevel: 'high',
      llmConnection: 'claude',
      enabledMemorySpaceRefs: [memoryRef],
      memoryWriteTargetRef: memoryRef,
      memorySelectionMode: 'explicit',
      transferredSessionSummary: 'handoff context',
      transferredSessionSummaryApplied: false,
    })
    sessionPersistenceQueue.cancel(created.id)

    expect(loadSession(workspace, created.id)).toMatchObject({
      model: 'claude-sonnet',
      thinkingLevel: 'high',
      llmConnection: 'claude',
      enabledMemorySpaceRefs: [memoryRef],
      memoryWriteTargetRef: memoryRef,
      memorySelectionMode: 'explicit',
      transferredSessionSummary: 'handoff context',
      transferredSessionSummaryApplied: false,
    })
  })
})
