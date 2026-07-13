import { describe, expect, test } from 'bun:test';
import { isCanonicalUuid } from '../../../utils/uuid-format.ts';
import { deriveGlobalSpace } from '../global-space.ts';
import {
  buildEnvironmentMemoryConnection,
  deriveEnvironmentMemoryConnectionId,
  environmentMemoryConnectionHasApiKey,
  getEnvironmentMemoryIdentity,
  isEnvironmentMemoryConnectionId,
  LOCAL_EMBEDDING_MODEL_ID,
} from '../environment.ts';

const EMPTY_ENV: NodeJS.ProcessEnv = {};
const INSTALL_A = '00000000-0000-4000-8000-00000000000a';
const INSTALL_B = '00000000-0000-4000-8000-00000000000b';

describe('environment memory connection', () => {
  test('uses the same defaults as qdrant.ts (canonical url) when env is empty', () => {
    const identity = getEnvironmentMemoryIdentity(EMPTY_ENV);
    expect(identity.provider).toBe('qdrant');
    expect(identity.url).toBe('http://127.0.0.1:6333/');
    expect(identity.collection).toBe('craft_memory');
    expect(identity.embedding).toEqual({ model: LOCAL_EMBEDDING_MODEL_ID, dimension: 384 });
  });

  test('derives a stable canonical UUID id (deterministic across calls, stable across restart)', () => {
    const id1 = deriveEnvironmentMemoryConnectionId(getEnvironmentMemoryIdentity(EMPTY_ENV), INSTALL_A);
    const id2 = deriveEnvironmentMemoryConnectionId(getEnvironmentMemoryIdentity(EMPTY_ENV), INSTALL_A);
    expect(id1).toBe(id2);
    expect(isCanonicalUuid(id1)).toBe(true);
  });

  test('distinct installations derive distinct ids for the same identity', () => {
    const a = buildEnvironmentMemoryConnection(INSTALL_A);
    const b = buildEnvironmentMemoryConnection(INSTALL_B);
    expect(a.connectionId).not.toBe(b.connectionId);
  });

  test('dimension does NOT affect the id but remains part of the embedding identity', () => {
    const d384 = buildEnvironmentMemoryConnection(INSTALL_A, { CRAFT_QDRANT_DIMENSION: '384' });
    const d1536 = buildEnvironmentMemoryConnection(INSTALL_A, { CRAFT_QDRANT_DIMENSION: '1536' });
    expect(d1536.embedding.dimension).toBe(1536);
    // Same URL/collection/installation → same id even though dimension differs.
    expect(d384.connectionId).toBe(d1536.connectionId);
  });

  test('falls back to the default dimension for invalid values', () => {
    expect(buildEnvironmentMemoryConnection(INSTALL_A, { CRAFT_QDRANT_DIMENSION: 'not-a-number' }).embedding.dimension).toBe(384);
    expect(buildEnvironmentMemoryConnection(INSTALL_A, { CRAFT_QDRANT_DIMENSION: '-1' }).embedding.dimension).toBe(384);
    expect(buildEnvironmentMemoryConnection(INSTALL_A, { CRAFT_QDRANT_DIMENSION: '0' }).embedding.dimension).toBe(384);
  });

  test('changing url or collection changes the derived id; equivalent origins do not', () => {
    const base = deriveEnvironmentMemoryConnectionId(getEnvironmentMemoryIdentity(EMPTY_ENV), INSTALL_A);
    const urlChanged = deriveEnvironmentMemoryConnectionId(getEnvironmentMemoryIdentity({ CRAFT_QDRANT_URL: 'https://remote:6333' }), INSTALL_A);
    const collChanged = deriveEnvironmentMemoryConnectionId(getEnvironmentMemoryIdentity({ CRAFT_QDRANT_COLLECTION: 'other' }), INSTALL_A);
    expect(urlChanged).not.toBe(base);
    expect(collChanged).not.toBe(base);
    // Equivalent origin (explicit default port) resolves to the same id.
    const equivalent = deriveEnvironmentMemoryConnectionId(getEnvironmentMemoryIdentity({ CRAFT_QDRANT_URL: 'http://127.0.0.1:6333/' }), INSTALL_A);
    expect(equivalent).toBe(base);
  });

  test('produces a secret-free, legacy-environment connection', () => {
    const conn = buildEnvironmentMemoryConnection(INSTALL_A, { CRAFT_QDRANT_URL: 'https://q.example.com', CRAFT_QDRANT_COLLECTION: 'craft_memory' });
    expect(conn.revision).toBe(1);
    expect(conn.provider).toBe('qdrant');
    expect(conn.credentialMode).toBe('legacy-environment');
    expect(conn.url).toBe('https://q.example.com/');
    expect(conn.spaces).toEqual([]);
    expect(conn.createdAt).toBe(0);
    expect(conn.updatedAt).toBe(0);
    expect(JSON.stringify(conn)).not.toContain('apiKey');
  });

  test('reflects CRAFT_PROJECT_MEMORY_ENABLED without affecting identity', () => {
    const disabled = buildEnvironmentMemoryConnection(INSTALL_A, { CRAFT_PROJECT_MEMORY_ENABLED: '0' });
    const enabled = buildEnvironmentMemoryConnection(INSTALL_A, {});
    expect(disabled.enabled).toBe(false);
    expect(enabled.enabled).toBe(true);
    expect(disabled.connectionId).toBe(enabled.connectionId);
  });

  test('exposes API key presence without moving/storing the secret', () => {
    expect(environmentMemoryConnectionHasApiKey({ CRAFT_QDRANT_API_KEY: 'sk-secret' })).toBe(true);
    expect(environmentMemoryConnectionHasApiKey({})).toBe(false);
    const conn = buildEnvironmentMemoryConnection(INSTALL_A, { CRAFT_QDRANT_API_KEY: 'sk-secret' });
    expect(JSON.stringify(conn)).not.toContain('sk-secret');
  });

  test('isEnvironmentMemoryConnectionId matches the derived connection for the same installation', () => {
    const conn = buildEnvironmentMemoryConnection(INSTALL_A, EMPTY_ENV);
    expect(isEnvironmentMemoryConnectionId(conn.connectionId, INSTALL_A, EMPTY_ENV)).toBe(true);
    expect(isEnvironmentMemoryConnectionId(conn.connectionId, INSTALL_B, EMPTY_ENV)).toBe(false);
    expect(isEnvironmentMemoryConnectionId('123e4567-e89b-12d3-a456-426614174000', INSTALL_A, EMPTY_ENV)).toBe(false);
  });

  test('has a derivable read-only Global space', () => {
    const conn = buildEnvironmentMemoryConnection(INSTALL_A, EMPTY_ENV);
    const global = deriveGlobalSpace(conn);
    expect(global.kind).toBe('global');
    expect(isCanonicalUuid(global.spaceId)).toBe(true);
  });
});
