/**
 * Resolver-policy tests for managed Memory references.
 */

import { describe, expect, test } from 'bun:test';
import { resolveManagedMemoryRefs, type ManagedMemorySpaceDescriptor } from '../resolver.ts';
import type { MemorySpaceRef } from '../types.ts';

const CONN = '123e4567-e89b-42d3-8456-426614174000';

function conn(spaces: ManagedMemorySpaceDescriptor[]) {
  return {
    connectionId: CONN,
    enabled: true,
    spaces,
  };
}

describe('resolveManagedMemoryRefs', () => {
  test('denies non-existent refs and does not invoke credential callback on deny-only paths', () => {
    const denied: MemorySpaceRef = { connectionId: CONN, spaceId: '00000000-0000-4000-8000-000000000000' };
    const calls: string[] = [];

    const result = resolveManagedMemoryRefs(
      [conn([{ spaceId: '11111111-0000-4000-8000-000000000000', kind: 'global', writable: false }])],
      { enabledMemorySpaceRefs: [denied] },
      { workspaceId: 'workspace-1' },
      { loadCredential: id => (calls.push(id), 'secret-token') },
    );

    expect(result.readRefs).toEqual([
      { connectionId: CONN, spaceId: targetGlobal.spaceId, kind: 'global', writable: true },
    ]);
    expect(result.writeRef).toBeUndefined();
    expect(result.deniedRefs).toEqual([{ code: 'space-not-found', ref: denied }]);
    expect(calls).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });

  test('checks workspace/project membership for read refs', () => {
    const customInScope = { spaceId: 'aaaaaaaa-1111-4000-8000-aaaaaaaaaaaa', kind: 'custom', writable: true } as const;
    const customWrongScope = { spaceId: '11111111-1111-4000-8000-aaaaaaaa0000', kind: 'custom', writable: true, workspaceId: 'ws-other' } as const;
    const projectSpace = { spaceId: 'bbbbbbbb-1111-4000-8000-bbbbbbbbbbbb', kind: 'project', writable: true, workspaceId: 'ws-1', projectId: 'pr-1' } as const;

    const result = resolveManagedMemoryRefs(
      [conn([customInScope, customWrongScope, projectSpace])],
      {
        enabledMemorySpaceRefs: [
          { connectionId: CONN, spaceId: customInScope.spaceId },
          { connectionId: CONN, spaceId: customWrongScope.spaceId },
          { connectionId: CONN, spaceId: projectSpace.spaceId },
        ],
      },
      { workspaceId: 'ws-1', projectId: 'pr-1' },
    );

    expect(result.deniedRefs).toEqual([
      { code: 'not-member', ref: { connectionId: CONN, spaceId: customWrongScope.spaceId } },
    ]);
    expect(result.readRefs).toEqual([
      { connectionId: CONN, spaceId: customInScope.spaceId, kind: 'custom', writable: true },
      { connectionId: CONN, spaceId: projectSpace.spaceId, kind: 'project', writable: true },
    ]);
  });

  test('denies write to disabled connections', () => {
    const targetWorkspace = { spaceId: '11111111-1111-4000-8000-111111111111', kind: 'workspace', writable: true, workspaceId: 'ws-1' } as const;
    const targetProject = { spaceId: '44444444-4444-4000-8000-444444444444', kind: 'project', writable: true, workspaceId: 'ws-1', projectId: 'pr-1' } as const;

    const result = resolveManagedMemoryRefs(
      [
        { connectionId: CONN, enabled: false, spaces: [targetWorkspace] },
        { connectionId: '223e4567-e89b-42d3-8456-426614174111', enabled: true, spaces: [targetProject] },
      ],
      {
        enabledMemorySpaceRefs: [{ connectionId: '223e4567-e89b-42d3-8456-426614174111', spaceId: targetProject.spaceId }],
        memoryWriteTargetRef: { connectionId: CONN, spaceId: targetWorkspace.spaceId },
      },
      { workspaceId: 'ws-1', projectId: 'pr-1' },
    );

    expect(result.readRefs).toEqual([
      { connectionId: '223e4567-e89b-42d3-8456-426614174111', spaceId: targetProject.spaceId, kind: targetProject.kind, writable: targetProject.writable },
    ]);
    expect(result.writeRef).toBeUndefined();
    expect(result.deniedRefs).toEqual([
      { code: 'connection-disabled', ref: { connectionId: CONN, spaceId: targetWorkspace.spaceId } },
    ]);
  });

  test('denies write to read-only spaces', () => {
    const targetProject = { spaceId: '44444444-4444-4000-8000-444444444444', kind: 'project', writable: false, workspaceId: 'ws-1', projectId: 'pr-1' } as const;

    const result = resolveManagedMemoryRefs(
      [
        { connectionId: CONN, enabled: true, spaces: [targetProject] },
      ],
      {
        enabledMemorySpaceRefs: [{ connectionId: CONN, spaceId: targetProject.spaceId }],
        memoryWriteTargetRef: { connectionId: CONN, spaceId: targetProject.spaceId },
      },
      { workspaceId: 'ws-1', projectId: 'pr-1' },
    );

    expect(result.deniedRefs).toEqual([
      { code: 'space-not-writable', ref: { connectionId: CONN, spaceId: targetProject.spaceId } },
    ]);
    expect(result.writeRef).toBeUndefined();
    expect(result.readRefs).toEqual([
      { connectionId: CONN, spaceId: targetProject.spaceId, kind: 'project', writable: false },
    ]);
  });

  test('denies write to global space', () => {
    const targetGlobal = { spaceId: '33333333-3333-4000-8000-333333333333', kind: 'global', writable: true } as const;

    const result = resolveManagedMemoryRefs(
      [
        { connectionId: CONN, enabled: true, spaces: [targetGlobal] },
      ],
      {
        enabledMemorySpaceRefs: [{ connectionId: CONN, spaceId: targetGlobal.spaceId }],
        memoryWriteTargetRef: { connectionId: CONN, spaceId: targetGlobal.spaceId },
      },
      { workspaceId: 'ws-1', projectId: 'pr-1' },
    );

    expect(result.deniedRefs).toEqual([
      { code: 'global-space-write-forbidden', ref: { connectionId: CONN, spaceId: targetGlobal.spaceId } },
    ]);
    expect(result.writeRef).toBeUndefined();
    expect(result.readRefs).toEqual([
      { connectionId: CONN, spaceId: targetGlobal.spaceId, kind: 'global', writable: true },
    ]);
  });

  test('allows only permitted write refs and invokes credential callback once for allowed connections', () => {
    const writableCustom = { spaceId: '11111111-3333-4000-8000-aaaaaaaaaaaa', kind: 'custom', writable: true } as const;
    let calls = 0;
    const result = resolveManagedMemoryRefs(
      [conn([{ spaceId: writableCustom.spaceId, kind: 'custom', writable: true }, { spaceId: '55555555-4444-4000-8000-bbbbbbbbbbbb', kind: 'workspace', writable: true, workspaceId: 'ws-1' }])],
      {
        enabledMemorySpaceRefs: [{ connectionId: CONN, spaceId: '55555555-4444-4000-8000-bbbbbbbbbbbb' }],
        memoryWriteTargetRef: { connectionId: CONN, spaceId: writableCustom.spaceId },
      },
      { workspaceId: 'ws-1', projectId: 'pr-1' },
      {
        loadCredential: () => {
          calls += 1;
          return 'secret-token';
        },
      },
    );

    expect(result.deniedRefs).toEqual([]);
    expect(result.readRefs).toEqual([
      { connectionId: CONN, spaceId: '55555555-4444-4000-8000-bbbbbbbbbbbb', kind: 'workspace', writable: true },
    ]);
    expect(result.writeRef).toEqual({ connectionId: CONN, spaceId: writableCustom.spaceId, kind: 'custom', writable: true });
    expect(calls).toBe(1);
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });
});
