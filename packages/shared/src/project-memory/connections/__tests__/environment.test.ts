import { describe, expect, test } from 'bun:test';
import { isUuid } from '../../../utils/uuid.ts';
import { validateMemoryConnectionsConfig } from '../validation.ts';
import { deriveGlobalSpace } from '../repository.ts';
import {
  buildEnvironmentMemoryConnection,
  deriveEnvironmentMemoryConnectionId,
  environmentMemoryConnectionHasApiKey,
  getEnvironmentMemoryIdentity,
  isEnvironmentMemoryConnectionId,
  LOCAL_EMBEDDING_MODEL_ID,
} from '../environment.ts';

const EMPTY_ENV: NodeJS.ProcessEnv = {};

describe('environment memory connection', () => {
  test('uses the same defaults as qdrant.ts when env is empty', () => {
    const identity = getEnvironmentMemoryIdentity(EMPTY_ENV);
    expect(identity.provider).toBe('qdrant');
    expect(identity.url).toBe('http://127.0.0.1:6333');
    expect(identity.collection).toBe('craft_memory');
    expect(identity.embedding).toEqual({ model: LOCAL_EMBEDDING_MODEL_ID, dimension: 384 });
  });

  test('derives a stable UUID id (deterministic across calls)', () => {
    const id1 = deriveEnvironmentMemoryConnectionId(getEnvironmentMemoryIdentity(EMPTY_ENV));
    const id2 = deriveEnvironmentMemoryConnectionId(getEnvironmentMemoryIdentity(EMPTY_ENV));
    expect(id1).toBe(id2);
    expect(isUuid(id1)).toBe(true);
  });

  test('preserves an arbitrary CRAFT_QDRANT_DIMENSION as identity', () => {
    const env: NodeJS.ProcessEnv = { CRAFT_QDRANT_DIMENSION: '1536' };
    const conn = buildEnvironmentMemoryConnection(env);
    expect(conn.embedding.dimension).toBe(1536);
    // Changing the dimension changes the derived identity.
    const other = buildEnvironmentMemoryConnection({ CRAFT_QDRANT_DIMENSION: '768' });
    expect(conn.connectionId).not.toBe(other.connectionId);
  });

  test('falls back to the default dimension for invalid values', () => {
    expect(buildEnvironmentMemoryConnection({ CRAFT_QDRANT_DIMENSION: 'not-a-number' }).embedding.dimension).toBe(384);
    expect(buildEnvironmentMemoryConnection({ CRAFT_QDRANT_DIMENSION: '-1' }).embedding.dimension).toBe(384);
    expect(buildEnvironmentMemoryConnection({ CRAFT_QDRANT_DIMENSION: '0' }).embedding.dimension).toBe(384);
  });

  test('changing url or collection changes the derived id', () => {
    const base = deriveEnvironmentMemoryConnectionId(getEnvironmentMemoryIdentity(EMPTY_ENV));
    const urlChanged = deriveEnvironmentMemoryConnectionId(getEnvironmentMemoryIdentity({ CRAFT_QDRANT_URL: 'https://remote:6333' }));
    const collChanged = deriveEnvironmentMemoryConnectionId(getEnvironmentMemoryIdentity({ CRAFT_QDRANT_COLLECTION: 'other' }));
    expect(urlChanged).not.toBe(base);
    expect(collChanged).not.toBe(base);
  });

  test('produces a valid, secret-free connection', () => {
    const conn = buildEnvironmentMemoryConnection({ CRAFT_QDRANT_URL: 'https://q.example.com', CRAFT_QDRANT_COLLECTION: 'craft_memory' });
    expect(conn.revision).toBe(1);
    expect(conn.provider).toBe('qdrant');
    expect(conn.spaces).toEqual([]);
    expect(conn.createdAt).toBe(0);
    expect(conn.updatedAt).toBe(0);
    // No secret is present anywhere on the config object.
    expect(JSON.stringify(conn)).not.toContain('apiKey');
    // Shape is valid enough to pass strict config validation.
    expect(validateMemoryConnectionsConfig({ version: 1, connections: [conn] }).valid).toBe(true);
  });

  test('reflects CRAFT_PROJECT_MEMORY_ENABLED without affecting identity', () => {
    const disabled = buildEnvironmentMemoryConnection({ CRAFT_PROJECT_MEMORY_ENABLED: '0' });
    const enabled = buildEnvironmentMemoryConnection({});
    expect(disabled.enabled).toBe(false);
    expect(enabled.enabled).toBe(true);
    expect(disabled.connectionId).toBe(enabled.connectionId); // enabled is not part of identity
  });

  test('exposes API key presence without moving/storing the secret', () => {
    expect(environmentMemoryConnectionHasApiKey({ CRAFT_QDRANT_API_KEY: 'sk-secret' })).toBe(true);
    expect(environmentMemoryConnectionHasApiKey({})).toBe(false);
    // The key never lands on the config object.
    const conn = buildEnvironmentMemoryConnection({ CRAFT_QDRANT_API_KEY: 'sk-secret' });
    expect(JSON.stringify(conn)).not.toContain('sk-secret');
  });

  test('isEnvironmentMemoryConnectionId matches the derived connection', () => {
    const conn = buildEnvironmentMemoryConnection(EMPTY_ENV);
    expect(isEnvironmentMemoryConnectionId(conn.connectionId, EMPTY_ENV)).toBe(true);
    expect(isEnvironmentMemoryConnectionId('123e4567-e89b-12d3-a456-426614174000', EMPTY_ENV)).toBe(false);
  });

  test('has a derivable read-only Global space', () => {
    const conn = buildEnvironmentMemoryConnection(EMPTY_ENV);
    const global = deriveGlobalSpace(conn);
    expect(global.kind).toBe('global');
    expect(isUuid(global.spaceId)).toBe(true);
  });
});
