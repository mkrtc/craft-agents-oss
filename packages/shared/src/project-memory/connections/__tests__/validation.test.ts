import { describe, expect, test } from 'bun:test';
import { randomUuid, uuidV5 } from '../../../utils/uuid.ts';
import { MEMORY_LIMITS } from '../limits.ts';
import { embeddingIdentityKey } from '../identity.ts';
import {
  canonicalizeMemoryUrl,
  normalizeNameKey,
  sortConnections,
  validateCreateMemoryConnectionInput,
  validateCreateMemorySpaceInput,
  validateMemoryConnectionsConfig,
  validateUpdateMemoryConnectionInput,
  validateUpdateMemorySpaceInput,
} from '../validation.ts';

const INSTALL = '00000000-0000-4000-8000-000000000000';

function validConnection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    connectionId: randomUuid(),
    revision: 1,
    provider: 'qdrant',
    url: 'http://127.0.0.1:6333/',
    collection: 'craft_memory',
    embedding: { model: 'craft-local-hash-v1', dimension: 384 },
    credentialMode: 'none',
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
    writable: true,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function config(connections: unknown[], root: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 1, revision: 0, installationId: INSTALL, connections, ...root };
}

describe('MEMORY_LIMITS (frozen contract)', () => {
  test('has the exact frozen values', () => {
    expect(MEMORY_LIMITS.MAX_CONNECTIONS).toBe(20);
    expect(MEMORY_LIMITS.MAX_SPACES_PER_CONNECTION).toBe(100);
    expect(MEMORY_LIMITS.MAX_SESSION_SPACE_REFS).toBe(50);
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

describe('canonicalizeMemoryUrl (security contract)', () => {
  test('reduces to a safe canonical origin with trailing slash', () => {
    expect(canonicalizeMemoryUrl('http://127.0.0.1:6333')).toBe('http://127.0.0.1:6333/');
    expect(canonicalizeMemoryUrl('https://Q.Example.COM')).toBe('https://q.example.com/');
  });

  test('collapses equivalent origins (default ports, casing, trailing slash)', () => {
    const a = canonicalizeMemoryUrl('http://host:80');
    const b = canonicalizeMemoryUrl('http://host');
    const c = canonicalizeMemoryUrl('http://HOST/');
    expect(a).toBe('http://host/');
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(canonicalizeMemoryUrl('https://host:443')).toBe('https://host/');
  });

  test('rejects userinfo, query, fragment, non-root path, control chars, and non-http', () => {
    expect(canonicalizeMemoryUrl('http://user:pass@host:6333')).toBeNull();
    expect(canonicalizeMemoryUrl('http://host:6333/?q=1')).toBeNull();
    expect(canonicalizeMemoryUrl('http://host:6333/#frag')).toBeNull();
    expect(canonicalizeMemoryUrl('http://host:6333/collections')).toBeNull();
    expect(canonicalizeMemoryUrl('http://ho\nst:6333')).toBeNull(); // embedded newline (CRLF injection)
    expect(canonicalizeMemoryUrl('http://host:63\t33')).toBeNull(); // embedded control char
    expect(canonicalizeMemoryUrl('ftp://host')).toBeNull();
    expect(canonicalizeMemoryUrl('http://host:99999')).toBeNull(); // malformed port
  });
});

describe('validateMemoryConnectionsConfig (on-disk, strict)', () => {
  test('accepts a minimal empty config', () => {
    const result = validateMemoryConnectionsConfig(config([]));
    expect(result.valid).toBe(true);
    expect(result.config.connections).toEqual([]);
    expect(result.config.revision).toBe(0);
    expect(result.config.installationId).toBe(INSTALL);
  });

  test('rejects a missing/invalid installationId and a negative root revision', () => {
    expect(validateMemoryConnectionsConfig({ version: 1, revision: 0, connections: [] }).valid).toBe(false);
    expect(validateMemoryConnectionsConfig({ version: 1, revision: 0, installationId: 'nope', connections: [] }).valid).toBe(false);
    expect(validateMemoryConnectionsConfig(config([], { revision: -1 })).valid).toBe(false);
  });

  test('accepts a valid connection and canonicalizes its url', () => {
    const result = validateMemoryConnectionsConfig(config([validConnection({ url: 'http://127.0.0.1:6333' })]));
    expect(result.valid).toBe(true);
    expect(result.config.connections[0]!.url).toBe('http://127.0.0.1:6333/');
    expect(result.config.connections[0]!.credentialMode).toBe('none');
  });

  test('rejects non-object root, unknown root fields, and wrong version', () => {
    expect(validateMemoryConnectionsConfig(null).valid).toBe(false);
    expect(validateMemoryConnectionsConfig([]).valid).toBe(false);
    expect(validateMemoryConnectionsConfig(config([], { secret: 'x' })).valid).toBe(false);
    expect(validateMemoryConnectionsConfig(config([], { version: 2 })).valid).toBe(false);
  });

  test('rejects unknown connection fields (no round-trip smuggling)', () => {
    const result = validateMemoryConnectionsConfig(config([validConnection({ apiKey: 'sk-secret', localPath: '/etc/passwd' })]));
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('unknown field');
  });

  test('rejects a stored global space (Global is derived, never stored)', () => {
    expect(validateMemoryConnectionsConfig(config([validConnection({ spaces: [validSpace({ kind: 'global' })] })])).valid).toBe(false);
  });

  test('rejects credentialMode "legacy-environment" on a stored connection', () => {
    const result = validateMemoryConnectionsConfig(config([validConnection({ credentialMode: 'legacy-environment' })]));
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('legacy-environment');
    // Accepts the two stored modes.
    expect(validateMemoryConnectionsConfig(config([validConnection({ credentialMode: 'stored-api-key' })])).valid).toBe(true);
    expect(validateMemoryConnectionsConfig(config([validConnection({ credentialMode: 'bogus' })])).valid).toBe(false);
  });

  test('requires writable on every stored space', () => {
    const noWritable = validSpace();
    delete noWritable.writable;
    expect(validateMemoryConnectionsConfig(config([validConnection({ spaces: [noWritable] })])).valid).toBe(false);
  });

  test('rejects a stored spaceId colliding with the derived Global id (injected deriver)', () => {
    const conn = validConnection();
    const globalId = uuidV5(`global:${conn.connectionId}`, '6f4d3b2a-1c9e-4f7a-8b2d-3e5a6c7d8e9f');
    const result = validateMemoryConnectionsConfig(
      config([validConnection({ ...conn, spaces: [validSpace({ spaceId: globalId })] })]),
      { deriveGlobalSpaceId: (id) => uuidV5(`global:${id}`, '6f4d3b2a-1c9e-4f7a-8b2d-3e5a6c7d8e9f') },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('Global space id');
  });

  test('rejects duplicate connection names case-insensitively', () => {
    expect(validateMemoryConnectionsConfig(config([validConnection({ name: 'Prod' }), validConnection({ name: 'prod' })])).valid).toBe(false);
  });

  test('collides composed and decomposed Unicode names (NFC)', () => {
    const composed = validConnection({ name: '\u00e9' });      // é (single code point)
    const decomposed = validConnection({ name: 'e\u0301' });   // e + combining acute accent
    const result = validateMemoryConnectionsConfig(config([composed, decomposed]));
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('duplicate connection name');
  });

  test('rejects duplicate space names and the reserved Global name', () => {
    expect(validateMemoryConnectionsConfig(config([validConnection({ spaces: [validSpace({ name: 'Notes' }), validSpace({ name: 'notes' })] })])).valid).toBe(false);
    expect(validateMemoryConnectionsConfig(config([validConnection({ spaces: [validSpace({ name: 'global' })] })])).valid).toBe(false);
  });

  test('rejects non-http url and bad collection charset', () => {
    expect(validateMemoryConnectionsConfig(config([validConnection({ url: 'ftp://host' })])).valid).toBe(false);
    expect(validateMemoryConnectionsConfig(config([validConnection({ collection: 'bad/name' })])).valid).toBe(false);
  });

  test('rejects out-of-range embedding dimension but preserves in-range identity', () => {
    expect(validateMemoryConnectionsConfig(config([validConnection({ embedding: { model: 'm', dimension: 0 } })])).valid).toBe(false);
    expect(validateMemoryConnectionsConfig(config([validConnection({ embedding: { model: 'm', dimension: 70000 } })])).valid).toBe(false);
    const ok = validateMemoryConnectionsConfig(config([validConnection({ embedding: { model: 'm', dimension: 1536 } })]));
    expect(ok.valid).toBe(true);
    expect(ok.config.connections[0]!.embedding.dimension).toBe(1536);
  });

  test('rejects a non-canonical (uppercase) UUID', () => {
    expect(validateMemoryConnectionsConfig(config([validConnection({ connectionId: 'ABCDEF01-0000-4000-8000-000000000000' })])).valid).toBe(false);
    expect(validateMemoryConnectionsConfig(config([validConnection({ connectionId: 'nope' })])).valid).toBe(false);
  });

  test('accepts a custom space with workspace binding but rejects projectId without workspaceId', () => {
    expect(validateMemoryConnectionsConfig(config([validConnection({ spaces: [validSpace({ kind: 'custom', workspaceId: 'ws-1' })] })])).valid).toBe(true);
    expect(validateMemoryConnectionsConfig(config([validConnection({ spaces: [validSpace({ kind: 'custom', projectId: 'pr-1' })] })])).valid).toBe(false);
  });

  test('enforces the max-connections limit', () => {
    const connections = Array.from({ length: MEMORY_LIMITS.MAX_CONNECTIONS + 1 }, (_, i) => validConnection({ name: `c${i}` }));
    expect(validateMemoryConnectionsConfig(config(connections)).valid).toBe(false);
  });

  test('enforces the max-spaces-per-connection limit', () => {
    const spaces = Array.from({ length: MEMORY_LIMITS.MAX_SPACES_PER_CONNECTION + 1 }, (_, i) => validSpace({ name: `s${i}` }));
    expect(validateMemoryConnectionsConfig(config([validConnection({ spaces })])).valid).toBe(false);
  });

  test('orders connections deterministically by createdAt then id', () => {
    const a = validConnection({ name: 'a', createdAt: 2000 });
    const b = validConnection({ name: 'b', createdAt: 1000 });
    const result = validateMemoryConnectionsConfig(config([a, b]));
    expect(result.valid).toBe(true);
    expect(result.config.connections.map(c => c.name)).toEqual(['b', 'a']);
  });
});

describe('embeddingIdentityKey', () => {
  test('is the canonical model:dimension identity string', () => {
    expect(embeddingIdentityKey({ model: 'craft-local-hash-v1', dimension: 384 })).toBe('craft-local-hash-v1:384');
  });
});

describe('sortConnections', () => {
  test('is stable and deterministic', () => {
    const base = { revision: 1, provider: 'qdrant' as const, url: 'http://h/', collection: 'c', embedding: { model: 'm', dimension: 1 }, credentialMode: 'none' as const, enabled: true, proactiveRemoteSearch: false, spaces: [], updatedAt: 0 };
    const a = { ...base, connectionId: 'bbbbbbbb-0000-4000-8000-000000000000', name: 'a', createdAt: 5 };
    const b = { ...base, connectionId: 'aaaaaaaa-0000-4000-8000-000000000000', name: 'b', createdAt: 5 };
    expect(sortConnections([a, b]).map(c => c.connectionId)).toEqual([b.connectionId, a.connectionId]);
  });
});

describe('validateCreateMemoryConnectionInput', () => {
  test('accepts a valid input, applies defaults, and canonicalizes the url', () => {
    const result = validateCreateMemoryConnectionInput({
      name: 'My Prod', url: 'https://qdrant.example.com', collection: 'craft_memory',
      embedding: { model: 'text-embedding-3-small', dimension: 1536 },
    });
    expect(result.valid).toBe(true);
    expect(result.value?.enabled).toBe(true);
    expect(result.value?.proactiveRemoteSearch).toBe(false);
    expect(result.value?.url).toBe('https://qdrant.example.com/');
  });

  test('accepts arbitrary bounded unicode/emoji names (NFC, trimmed)', () => {
    const result = validateCreateMemoryConnectionInput({
      name: '  My Memory 🧠 (prod, RU)  ', url: 'http://127.0.0.1:6333', collection: 'craft_memory',
      embedding: { model: 'm', dimension: 384 },
    });
    expect(result.valid).toBe(true);
    expect(result.value?.name).toBe('My Memory 🧠 (prod, RU)');
  });

  test('bounds names by code points: 100 emoji accepted, 101 rejected', () => {
    const base = { url: 'http://h', collection: 'c', embedding: { model: 'm', dimension: 1 } };
    expect(validateCreateMemoryConnectionInput({ ...base, name: '🧠'.repeat(100) }).valid).toBe(true);
    expect(validateCreateMemoryConnectionInput({ ...base, name: '🧠'.repeat(101) }).valid).toBe(false);
  });

  test('rejects unknown fields and empty name', () => {
    expect(validateCreateMemoryConnectionInput({ name: 'x', url: 'http://h', collection: 'c', embedding: { model: 'm', dimension: 1 }, apiKey: 'sk' }).valid).toBe(false);
    expect(validateCreateMemoryConnectionInput({ name: '   ', url: 'http://h', collection: 'c', embedding: { model: 'm', dimension: 1 } }).valid).toBe(false);
  });
});

describe('validateUpdateMemoryConnectionInput', () => {
  test('accepts mutable fields', () => {
    const result = validateUpdateMemoryConnectionInput({ name: 'Renamed', enabled: false, proactiveRemoteSearch: true });
    expect(result.valid).toBe(true);
    expect(result.value).toEqual({ name: 'Renamed', enabled: false, proactiveRemoteSearch: true });
  });

  test('rejects immutable identity fields (incl. credentialMode)', () => {
    for (const key of ['url', 'collection', 'embedding', 'provider', 'connectionId', 'revision', 'credentialMode']) {
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
  test('accepts workspace/project/custom spaces, defaulting writable to true', () => {
    const ws = validateCreateMemorySpaceInput({ kind: 'workspace', name: 'WS', workspaceId: 'ws-1' });
    expect(ws.valid).toBe(true);
    expect(ws.value?.writable).toBe(true);
    expect(validateCreateMemorySpaceInput({ kind: 'project', name: 'P', workspaceId: 'ws-1', projectId: 'pr-1', writable: false }).value?.writable).toBe(false);
    expect(validateCreateMemorySpaceInput({ kind: 'custom', name: 'C', instructions: 'hi' }).valid).toBe(true);
  });

  test('custom accepts optional workspaceId but requires it for projectId', () => {
    expect(validateCreateMemorySpaceInput({ kind: 'custom', name: 'C', workspaceId: 'ws-1' }).valid).toBe(true);
    expect(validateCreateMemorySpaceInput({ kind: 'custom', name: 'C', workspaceId: 'ws-1', projectId: 'pr-1' }).valid).toBe(true);
    expect(validateCreateMemorySpaceInput({ kind: 'custom', name: 'C', projectId: 'pr-1' }).valid).toBe(false);
  });

  test('rejects global kind (not creatable) and missing binding ids', () => {
    expect(validateCreateMemorySpaceInput({ kind: 'global', name: 'G' }).valid).toBe(false);
    expect(validateCreateMemorySpaceInput({ kind: 'workspace', name: 'WS' }).valid).toBe(false);
    expect(validateCreateMemorySpaceInput({ kind: 'project', name: 'P', workspaceId: 'ws-1' }).valid).toBe(false);
  });
});

describe('validateUpdateMemorySpaceInput', () => {
  test('accepts name/instructions/writable and null-clear', () => {
    expect(validateUpdateMemorySpaceInput({ name: 'X' }).valid).toBe(true);
    expect(validateUpdateMemorySpaceInput({ writable: false }).value).toEqual({ writable: false });
    expect(validateUpdateMemorySpaceInput({ instructions: null }).value).toEqual({ instructions: null });
  });

  test('rejects unknown and binding-change fields', () => {
    expect(validateUpdateMemorySpaceInput({ kind: 'workspace' }).valid).toBe(false);
    expect(validateUpdateMemorySpaceInput({ workspaceId: 'ws' }).valid).toBe(false);
  });
});

describe('normalizeNameKey', () => {
  test('NFC-normalizes, trims, and lowercases', () => {
    expect(normalizeNameKey('  Prod  ')).toBe('prod');
    expect(normalizeNameKey('\u00e9')).toBe(normalizeNameKey('e\u0301'));
  });
});
