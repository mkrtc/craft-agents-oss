import { describe, expect, test } from 'bun:test';
import { randomUuid } from '../../../utils/uuid.ts';
import { MEMORY_LIMITS } from '../limits.ts';
import {
  normalizeNameKey,
  sortConnections,
  validateCreateMemoryConnectionInput,
  validateCreateMemorySpaceInput,
  validateMemoryConnectionsConfig,
  validateUpdateMemoryConnectionInput,
  validateUpdateMemorySpaceInput,
} from '../validation.ts';

function validConnection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    connectionId: randomUuid(),
    revision: 1,
    provider: 'qdrant',
    url: 'http://127.0.0.1:6333',
    collection: 'craft_memory',
    embedding: { model: 'craft-local-hash-v1', dimension: 384 },
    name: 'Alpha',
    enabled: true,
    proactiveRemoteSearch: false,
    spaces: [],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function validSpace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    spaceId: randomUuid(),
    kind: 'custom',
    name: 'Notes',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe('MEMORY_LIMITS (frozen contract)', () => {
  test('has the exact frozen values', () => {
    expect(MEMORY_LIMITS.MAX_CONNECTIONS).toBe(50);
    expect(MEMORY_LIMITS.MAX_SPACES_PER_CONNECTION).toBe(200);
    expect(MEMORY_LIMITS.CONNECTION_NAME_MAX_CHARS).toBe(100);
    expect(MEMORY_LIMITS.SPACE_NAME_MAX_CHARS).toBe(100);
    expect(MEMORY_LIMITS.SPACE_INSTRUCTIONS_MAX_CHARS).toBe(4_000);
    expect(MEMORY_LIMITS.URL_MAX_CHARS).toBe(2_048);
    expect(MEMORY_LIMITS.COLLECTION_NAME_MAX_CHARS).toBe(255);
    expect(MEMORY_LIMITS.EMBEDDING_MODEL_MAX_CHARS).toBe(200);
    expect(MEMORY_LIMITS.EMBEDDING_DIMENSION_MIN).toBe(1);
    expect(MEMORY_LIMITS.EMBEDDING_DIMENSION_MAX).toBe(65_536);
  });
});

describe('validateMemoryConnectionsConfig (on-disk, strict)', () => {
  test('accepts a minimal empty config', () => {
    const result = validateMemoryConnectionsConfig({ version: 1, connections: [] });
    expect(result.valid).toBe(true);
    expect(result.config.connections).toEqual([]);
  });

  test('accepts a valid connection and rebuilds it canonically', () => {
    const result = validateMemoryConnectionsConfig({ version: 1, connections: [validConnection()] });
    expect(result.valid).toBe(true);
    expect(result.config.connections).toHaveLength(1);
    expect(result.config.connections[0]!.provider).toBe('qdrant');
  });

  test('rejects a non-object root', () => {
    expect(validateMemoryConnectionsConfig(null).valid).toBe(false);
    expect(validateMemoryConnectionsConfig([]).valid).toBe(false);
  });

  test('rejects unknown root fields', () => {
    const result = validateMemoryConnectionsConfig({ version: 1, connections: [], secret: 'x' });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('unknown field');
  });

  test('rejects wrong version', () => {
    expect(validateMemoryConnectionsConfig({ version: 2, connections: [] }).valid).toBe(false);
  });

  test('rejects unknown connection fields (no round-trip smuggling)', () => {
    const result = validateMemoryConnectionsConfig({
      version: 1,
      connections: [validConnection({ apiKey: 'sk-secret', localPath: '/etc/passwd' })],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('unknown field');
  });

  test('rejects a stored global space (Global is derived, never stored)', () => {
    const result = validateMemoryConnectionsConfig({
      version: 1,
      connections: [validConnection({ spaces: [validSpace({ kind: 'global' })] })],
    });
    expect(result.valid).toBe(false);
  });

  test('rejects duplicate connection names case-insensitively', () => {
    const result = validateMemoryConnectionsConfig({
      version: 1,
      connections: [validConnection({ name: 'Prod' }), validConnection({ name: 'prod' })],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('duplicate connection name');
  });

  test('rejects duplicate space names within a connection', () => {
    const result = validateMemoryConnectionsConfig({
      version: 1,
      connections: [validConnection({
        spaces: [validSpace({ name: 'Notes' }), validSpace({ name: 'notes' })],
      })],
    });
    expect(result.valid).toBe(false);
  });

  test('rejects a space named like the reserved Global space', () => {
    const result = validateMemoryConnectionsConfig({
      version: 1,
      connections: [validConnection({ spaces: [validSpace({ name: 'global' })] })],
    });
    expect(result.valid).toBe(false);
  });

  test('rejects non-http url and bad collection charset', () => {
    expect(validateMemoryConnectionsConfig({ version: 1, connections: [validConnection({ url: 'ftp://host' })] }).valid).toBe(false);
    expect(validateMemoryConnectionsConfig({ version: 1, connections: [validConnection({ collection: 'bad/name' })] }).valid).toBe(false);
  });

  test('rejects out-of-range embedding dimension but preserves in-range identity', () => {
    expect(validateMemoryConnectionsConfig({ version: 1, connections: [validConnection({ embedding: { model: 'm', dimension: 0 } })] }).valid).toBe(false);
    expect(validateMemoryConnectionsConfig({ version: 1, connections: [validConnection({ embedding: { model: 'm', dimension: 70000 } })] }).valid).toBe(false);
    const ok = validateMemoryConnectionsConfig({ version: 1, connections: [validConnection({ embedding: { model: 'm', dimension: 1536 } })] });
    expect(ok.valid).toBe(true);
    expect(ok.config.connections[0]!.embedding.dimension).toBe(1536);
  });

  test('rejects a connection with an invalid (non-UUID) id', () => {
    expect(validateMemoryConnectionsConfig({ version: 1, connections: [validConnection({ connectionId: 'nope' })] }).valid).toBe(false);
  });

  test('enforces the max-connections limit', () => {
    const connections = Array.from({ length: MEMORY_LIMITS.MAX_CONNECTIONS + 1 }, (_, i) => validConnection({ name: `c${i}` }));
    expect(validateMemoryConnectionsConfig({ version: 1, connections }).valid).toBe(false);
  });

  test('enforces the max-spaces-per-connection limit', () => {
    const spaces = Array.from({ length: MEMORY_LIMITS.MAX_SPACES_PER_CONNECTION + 1 }, (_, i) => validSpace({ name: `s${i}` }));
    expect(validateMemoryConnectionsConfig({ version: 1, connections: [validConnection({ spaces })] }).valid).toBe(false);
  });

  test('orders connections deterministically by createdAt then id', () => {
    const a = validConnection({ name: 'a', createdAt: 2000 });
    const b = validConnection({ name: 'b', createdAt: 1000 });
    const result = validateMemoryConnectionsConfig({ version: 1, connections: [a, b] });
    expect(result.valid).toBe(true);
    expect(result.config.connections.map(c => c.name)).toEqual(['b', 'a']);
  });
});

describe('sortConnections', () => {
  test('is stable and deterministic', () => {
    const base = { revision: 1, provider: 'qdrant' as const, url: 'http://h', collection: 'c', embedding: { model: 'm', dimension: 1 }, enabled: true, proactiveRemoteSearch: false, spaces: [], updatedAt: 0 };
    const a = { ...base, connectionId: 'bbbbbbbb-0000-4000-8000-000000000000', name: 'a', createdAt: 5 };
    const b = { ...base, connectionId: 'aaaaaaaa-0000-4000-8000-000000000000', name: 'b', createdAt: 5 };
    expect(sortConnections([a, b]).map(c => c.connectionId)).toEqual([b.connectionId, a.connectionId]);
  });
});

describe('validateCreateMemoryConnectionInput', () => {
  test('accepts a valid input and applies defaults', () => {
    const result = validateCreateMemoryConnectionInput({
      name: 'My Prod', url: 'https://qdrant.example.com', collection: 'craft_memory',
      embedding: { model: 'text-embedding-3-small', dimension: 1536 },
    });
    expect(result.valid).toBe(true);
    expect(result.value?.enabled).toBe(true);
    expect(result.value?.proactiveRemoteSearch).toBe(false);
  });

  test('accepts arbitrary bounded unicode/emoji names', () => {
    const result = validateCreateMemoryConnectionInput({
      name: '  My Memory 🧠 (prod, RU)  ', url: 'http://127.0.0.1:6333', collection: 'craft_memory',
      embedding: { model: 'm', dimension: 384 },
    });
    expect(result.valid).toBe(true);
    expect(result.value?.name).toBe('My Memory 🧠 (prod, RU)'); // trimmed
  });

  test('rejects unknown fields and empty name', () => {
    expect(validateCreateMemoryConnectionInput({ name: 'x', url: 'http://h', collection: 'c', embedding: { model: 'm', dimension: 1 }, apiKey: 'sk' }).valid).toBe(false);
    expect(validateCreateMemoryConnectionInput({ name: '   ', url: 'http://h', collection: 'c', embedding: { model: 'm', dimension: 1 } }).valid).toBe(false);
  });

  test('rejects an over-long name', () => {
    const name = 'x'.repeat(MEMORY_LIMITS.CONNECTION_NAME_MAX_CHARS + 1);
    expect(validateCreateMemoryConnectionInput({ name, url: 'http://h', collection: 'c', embedding: { model: 'm', dimension: 1 } }).valid).toBe(false);
  });
});

describe('validateUpdateMemoryConnectionInput', () => {
  test('accepts mutable fields', () => {
    const result = validateUpdateMemoryConnectionInput({ name: 'Renamed', enabled: false, proactiveRemoteSearch: true });
    expect(result.valid).toBe(true);
    expect(result.value).toEqual({ name: 'Renamed', enabled: false, proactiveRemoteSearch: true });
  });

  test('rejects immutable identity fields', () => {
    for (const key of ['url', 'collection', 'embedding', 'provider', 'connectionId', 'revision']) {
      const result = validateUpdateMemoryConnectionInput({ [key]: 'x' });
      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toContain('immutable');
    }
  });

  test('rejects unknown fields', () => {
    expect(validateUpdateMemoryConnectionInput({ nope: 1 }).valid).toBe(false);
  });
});

describe('validateCreateMemorySpaceInput', () => {
  test('accepts workspace/project/custom spaces', () => {
    expect(validateCreateMemorySpaceInput({ kind: 'workspace', name: 'WS', workspaceId: 'ws-1' }).valid).toBe(true);
    expect(validateCreateMemorySpaceInput({ kind: 'project', name: 'P', workspaceId: 'ws-1', projectId: 'pr-1' }).valid).toBe(true);
    expect(validateCreateMemorySpaceInput({ kind: 'custom', name: 'C', instructions: 'hi' }).valid).toBe(true);
  });

  test('rejects global kind (not creatable) and missing binding ids', () => {
    expect(validateCreateMemorySpaceInput({ kind: 'global', name: 'G' }).valid).toBe(false);
    expect(validateCreateMemorySpaceInput({ kind: 'workspace', name: 'WS' }).valid).toBe(false);
    expect(validateCreateMemorySpaceInput({ kind: 'project', name: 'P', workspaceId: 'ws-1' }).valid).toBe(false);
  });

  test('rejects unknown fields', () => {
    expect(validateCreateMemorySpaceInput({ kind: 'custom', name: 'C', workspaceId: 'ws-1' }).valid).toBe(false);
  });
});

describe('validateUpdateMemorySpaceInput', () => {
  test('accepts name/instructions and null-clear', () => {
    expect(validateUpdateMemorySpaceInput({ name: 'X' }).valid).toBe(true);
    expect(validateUpdateMemorySpaceInput({ instructions: null }).value).toEqual({ instructions: null });
  });

  test('rejects unknown and binding-change fields', () => {
    expect(validateUpdateMemorySpaceInput({ kind: 'workspace' }).valid).toBe(false);
    expect(validateUpdateMemorySpaceInput({ workspaceId: 'ws' }).valid).toBe(false);
  });
});

describe('normalizeNameKey', () => {
  test('trims and lowercases', () => {
    expect(normalizeNameKey('  Prod  ')).toBe('prod');
  });
});
