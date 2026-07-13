import { describe, expect, test } from 'bun:test';
import { SESSION_PERSISTENT_FIELDS } from '../types.ts';
import type { SessionConfig, StoredSession } from '../types.ts';
import { pickSessionFields } from '../utils.ts';
import { createSessionHeader } from '../jsonl.ts';
import type { MemorySpaceRef } from '../../project-memory/connections/types.ts';

const readRef: MemorySpaceRef = { connectionId: '123e4567-e89b-12d3-a456-426614174000', spaceId: 'aaaaaaaa-e89b-42d3-8456-426614174000' };
const writeRef: MemorySpaceRef = { connectionId: '123e4567-e89b-12d3-a456-426614174000', spaceId: 'bbbbbbbb-e89b-42d3-8456-426614174000' };

function baseSession(extra: Partial<SessionConfig>): StoredSession {
  return {
    id: 's1',
    workspaceRootPath: '/tmp/ws',
    createdAt: 1,
    lastUsedAt: 1,
    messages: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    ...extra,
  } as StoredSession;
}

describe('session memory selection fields', () => {
  test('SESSION_PERSISTENT_FIELDS includes the memory selection fields', () => {
    expect(SESSION_PERSISTENT_FIELDS).toContain('enabledMemorySpaceRefs');
    expect(SESSION_PERSISTENT_FIELDS).toContain('memoryWriteTargetRef');
    expect(SESSION_PERSISTENT_FIELDS).toContain('memorySelectionMode');
  });

  test('pickSessionFields preserves the memory fields when set', () => {
    const picked = pickSessionFields(baseSession({
      enabledMemorySpaceRefs: [readRef],
      memoryWriteTargetRef: writeRef,
      memorySelectionMode: 'explicit',
    }));
    expect(picked.enabledMemorySpaceRefs).toEqual([readRef]);
    expect(picked.memoryWriteTargetRef).toEqual(writeRef);
    expect(picked.memorySelectionMode).toBe('explicit');
  });

  test('pickSessionFields omits the memory fields when absent (backwards compatible)', () => {
    const picked = pickSessionFields(baseSession({}));
    expect('enabledMemorySpaceRefs' in picked).toBe(false);
    expect('memoryWriteTargetRef' in picked).toBe(false);
    expect('memorySelectionMode' in picked).toBe(false);
  });

  test('header serialization carries the memory fields (JSONL round-trip proxy)', () => {
    const header = createSessionHeader(baseSession({
      enabledMemorySpaceRefs: [readRef, writeRef],
      memoryWriteTargetRef: writeRef,
      memorySelectionMode: 'explicit',
    }));
    // Survives JSON serialization exactly as line 1 of session.jsonl would.
    const roundTripped = JSON.parse(JSON.stringify(header));
    expect(roundTripped.enabledMemorySpaceRefs).toEqual([readRef, writeRef]);
    expect(roundTripped.memoryWriteTargetRef).toEqual(writeRef);
    expect(roundTripped.memorySelectionMode).toBe('explicit');
  });
});
