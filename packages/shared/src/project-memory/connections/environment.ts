/**
 * Deterministic synthetic "environment" Memory connection.
 *
 * Provides backward compatibility with the existing `CRAFT_QDRANT_*` env setup:
 * it exposes those defaults as a normal (read-only) connection so the rest of
 * the system can treat env-based memory the same as user-created connections.
 *
 * - The connection id is DERIVED (stable across restarts) from the connection
 *   identity: provider + url + collection + embedding model + dimension.
 * - The arbitrary `CRAFT_QDRANT_DIMENSION` is preserved verbatim as part of the
 *   embedding identity (changing it changes the derived id — that is intended).
 * - The env API key (`CRAFT_QDRANT_API_KEY`) is NEVER moved or stored here; only
 *   its presence is exposed via {@link environmentMemoryConnectionHasApiKey}.
 *
 * Defaults mirror `getDefaultProjectMemoryOptions()` in ../qdrant.ts.
 */

import { deterministicUuid } from '../../utils/uuid.ts';
import type { MemoryConnectionConfig, MemoryEmbeddingIdentity } from './types.ts';

/** Stable identifier for the built-in local hash embedding. */
export const LOCAL_EMBEDDING_MODEL_ID = 'craft-local-hash-v1';

/** Display name of the synthetic environment connection. */
export const ENVIRONMENT_MEMORY_CONNECTION_NAME = 'Environment';

const DEFAULT_QDRANT_URL = 'http://127.0.0.1:6333';
const DEFAULT_QDRANT_COLLECTION = 'craft_memory';
const DEFAULT_EMBEDDING_DIMENSION = 384;

/** Mirror of ../qdrant.ts:parseProjectMemoryDimension — preserves arbitrary valid dimensions. */
function parseEnvDimension(value: string | undefined): number {
  if (!value) return DEFAULT_EMBEDDING_DIMENSION;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_EMBEDDING_DIMENSION;
  return parsed;
}

export interface EnvironmentMemoryIdentity {
  provider: 'qdrant';
  url: string;
  collection: string;
  embedding: MemoryEmbeddingIdentity;
}

/** Read the non-secret environment memory identity from env vars. */
export function getEnvironmentMemoryIdentity(env: NodeJS.ProcessEnv = process.env): EnvironmentMemoryIdentity {
  return {
    provider: 'qdrant',
    url: env.CRAFT_QDRANT_URL || DEFAULT_QDRANT_URL,
    collection: env.CRAFT_QDRANT_COLLECTION || DEFAULT_QDRANT_COLLECTION,
    embedding: {
      model: LOCAL_EMBEDDING_MODEL_ID,
      dimension: parseEnvDimension(env.CRAFT_QDRANT_DIMENSION),
    },
  };
}

/** Deterministic connection id derived from the environment identity. */
export function deriveEnvironmentMemoryConnectionId(identity: EnvironmentMemoryIdentity): string {
  return deterministicUuid([
    'memory-connection',
    'environment',
    identity.provider,
    identity.url,
    identity.collection,
    identity.embedding.model,
    String(identity.embedding.dimension),
  ]);
}

/**
 * Build the synthetic environment connection. Fully deterministic (fixed epoch
 * timestamps, derived id) and secret-free.
 */
export function buildEnvironmentMemoryConnection(env: NodeJS.ProcessEnv = process.env): MemoryConnectionConfig {
  const identity = getEnvironmentMemoryIdentity(env);
  return {
    connectionId: deriveEnvironmentMemoryConnectionId(identity),
    revision: 1,
    provider: identity.provider,
    url: identity.url,
    collection: identity.collection,
    embedding: identity.embedding,
    name: ENVIRONMENT_MEMORY_CONNECTION_NAME,
    enabled: env.CRAFT_PROJECT_MEMORY_ENABLED !== '0',
    proactiveRemoteSearch: false,
    spaces: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

/** Whether an env memory API key is present (never exposes the value). */
export function environmentMemoryConnectionHasApiKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.CRAFT_QDRANT_API_KEY);
}

/** Whether `connectionId` refers to the current environment connection. */
export function isEnvironmentMemoryConnectionId(connectionId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return connectionId === deriveEnvironmentMemoryConnectionId(getEnvironmentMemoryIdentity(env));
}
