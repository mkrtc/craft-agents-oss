import { describe, expect, test } from 'bun:test';
import { randomUuid } from '../../../utils/uuid.ts';
import { deriveGlobalSpaceId } from '../global-space.ts';
import { toMemoryConnectionSummaryDto, toMemorySpaceDto } from '../dto.ts';
import { toMemoryConnectionDetailDto, toMemoryConnectionsSnapshotDto } from '../mappers.ts';
import type { MemoryConnectionConfig, StoredMemorySpaceConfig } from '../types.ts';

function connection(spaces: StoredMemorySpaceConfig[] = []): MemoryConnectionConfig {
  return {
    connectionId: randomUuid(),
    revision: 3,
    provider: 'qdrant',
    url: 'https://q.example.com/',
    collection: 'craft_memory',
    embedding: { model: 'text-embedding-3-small', dimension: 1536 },
    credentialMode: 'stored-api-key',
    name: 'Prod',
    enabled: true,
    proactiveRemoteSearch: false,
    spaces,
    createdAt: 10,
    updatedAt: 20,
  };
}

describe('DTO mappers (secret-free)', () => {
  test('summary DTO carries no secret, exposes credentialMode, counts the derived Global space', () => {
    const conn = connection([{ kind: 'custom', spaceId: randomUuid(), name: 'Notes', writable: true, createdAt: 1, updatedAt: 1 }]);
    const dto = toMemoryConnectionSummaryDto(conn);
    expect(dto.spaceCount).toBe(2); // 1 stored + derived global
    expect(dto.credentialMode).toBe('stored-api-key');
    expect(dto.url).toBe('https://q.example.com/');
    expect(dto.hasApiKey).toBe(false);
    expect(dto.isEnvironment).toBe(false);
    expect(Object.keys(dto)).not.toContain('apiKey');
    expect(Object.keys(dto)).not.toContain('spaces');
  });

  test('context populates hasApiKey / isEnvironment', () => {
    const dto = toMemoryConnectionSummaryDto(connection(), { hasApiKey: true, isEnvironment: true });
    expect(dto.hasApiKey).toBe(true);
    expect(dto.isEnvironment).toBe(true);
  });

  test('detail DTO lists the read-only Global space first', () => {
    const conn = connection([
      { kind: 'workspace', spaceId: randomUuid(), name: 'WS', workspaceId: 'ws-1', writable: true, createdAt: 1, updatedAt: 1 },
    ]);
    const dto = toMemoryConnectionDetailDto(conn);
    expect(dto.spaces[0]!.kind).toBe('global');
    expect(dto.spaces[0]!.readOnly).toBe(true);
    expect(dto.spaces[0]!.writable).toBeUndefined();
    expect(dto.spaces[0]!.spaceId).toBe(deriveGlobalSpaceId(conn.connectionId));
    expect(dto.spaces[1]!.kind).toBe('workspace');
    expect(dto.spaces[1]!.readOnly).toBe(false);
    expect(dto.spaces[1]!.writable).toBe(true);
    expect(dto.spaces[1]!.workspaceId).toBe('ws-1');
  });

  test('space DTO includes binding ids + writable and omits absent instructions', () => {
    const workspace = toMemorySpaceDto({ kind: 'workspace', spaceId: randomUuid(), name: 'WS', workspaceId: 'ws-1', writable: false, createdAt: 1, updatedAt: 1 });
    expect(workspace.workspaceId).toBe('ws-1');
    expect(workspace.writable).toBe(false);
    expect(workspace.projectId).toBeUndefined();
    expect(workspace.instructions).toBeUndefined();

    const project = toMemorySpaceDto({ kind: 'project', spaceId: randomUuid(), name: 'P', workspaceId: 'ws-1', projectId: 'pr-1', writable: true, instructions: 'hi', createdAt: 1, updatedAt: 1 });
    expect(project.projectId).toBe('pr-1');
    expect(project.instructions).toBe('hi');

    const custom = toMemorySpaceDto({ kind: 'custom', spaceId: randomUuid(), name: 'C', workspaceId: 'ws-1', writable: true, createdAt: 1, updatedAt: 1 });
    expect(custom.workspaceId).toBe('ws-1');
    expect(custom.projectId).toBeUndefined();
  });

  test('snapshot DTO carries the root revision alongside connection summaries', () => {
    const snapshot = toMemoryConnectionsSnapshotDto(7, [connection(), connection()]);
    expect(snapshot.revision).toBe(7);
    expect(snapshot.connections).toHaveLength(2);
  });
});
