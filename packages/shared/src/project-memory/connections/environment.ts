/**
 * Deterministic synthetic "environment" Memory connection (backend-only).
 *
 * Provides backward compatibility with the existing `CRAFT_QDRANT_*` env setup:
 * it exposes those defaults as a normal connection so the rest of the system can
 * treat env-based memory the same as user-created connections.
 *
 * - The connection id is a real RFC-4122 v5 UUID derived under the backend
 *   installation namespace (`installationId`) from the connection's canonical
 *   URL + collection. The embedding **dimension does NOT affect the id** (it is
 *   still preserved as part of the embedding identity), so a dimension change
 *   never re-keys the environment connection. Distinct installations derive
 *   distinct ids for the same URL/collection.
 * - The env API key (`CRAFT_QDRANT_API_KEY`) is NEVER moved or stored here; the
 *   connection's `credentialMode` is `'legacy-environment'` and only its
 *   presence is exposed via {@link environmentMemoryConnectionHasApiKey}.
 *
 * Defaults mirror `getDefaultProjectMemoryOptions()` in ../qdrant.ts.
 */

import { uuidV5 } from '../../utils/uuid.ts';
import { canonicalizeMemoryUrl } from './validation.ts';
import type { MemoryConnectionConfig, MemoryEmbeddingIdentity } from './types.ts';

/** Stable identifier for the built-in local hash embedding. */
export const LOCAL_EMBEDDING_MODEL_ID = 'craft-local-hash-v1';

/** Display name of the synthetic environment connection. */
export const ENVIRONMENT_MEMORY_CONNECTION_NAME = 'Environment';

const DEFAULT_QDRANT_URL = 'http://127.0.0.1:6333';
const DEFAULT_QDRANT_COLLECTION = 'craft_memory';
const DEFAULT_EMBEDDING_DIMENSION = 384;
/** Canonical form of the default URL, used when the env URL is missing/invalid. */
const DEFAULT_QDRANT_URL_CANONICAL = canonicalizeMemoryUrl(DEFAULT_QDRANT_URL) ?? 'http://127.0.0.1:6333/';

/** Mirror of ../qdrant.ts:parseProjectMemoryDimension — preserves arbitrary valid dimensions. */
function parseEnvDimension(value: string | undefined): number {
  if (!value) return DEFAULT_EMBEDDING_DIMENSION;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_EMBEDDING_DIMENSION;
  return parsed;
}

export interface EnvironmentMemoryIdentity {
  provider: 'qdrant';
  /** Canonical origin URL. */
  url: string;
  collection: string;
  embedding: MemoryEmbeddingIdentity;
}

/** Read the non-secret environment memory identity from env vars (URL canonicalized). */
export function getEnvironmentMemoryIdentity(env: NodeJS.ProcessEnv = process.env): EnvironmentMemoryIdentity {
  const url = canonicalizeMemoryUrl(env.CRAFT_QDRANT_URL) ?? DEFAULT_QDRANT_URL_CANONICAL;
  return {
    provider: 'qdrant',
    url,
    collection: env.CRAFT_QDRANT_COLLECTION || DEFAULT_QDRANT_COLLECTION,
    embedding: {
      model: LOCAL_EMBEDDING_MODEL_ID,
      dimension: parseEnvDimension(env.CRAFT_QDRANT_DIMENSION),
    },
  };
}

/**
 * Deterministic connection id: UUIDv5(name = canonical URL + collection,
 * namespace = installationId). Dimension is intentionally excluded.
 */
export function deriveEnvironmentMemoryConnectionId(identity: EnvironmentMemoryIdentity, installationId: string): string {
  return uuidV5(`env:${identity.provider}:${identity.url}:${identity.collection}`, installationId);
}

/**
 * Build the synthetic environment connection. Fully deterministic (fixed epoch
 * timestamps, derived id) and secret-free.
 */
export function buildEnvironmentMemoryConnection(
  installationId: string,
  env: NodeJS.ProcessEnv = process.env,
): MemoryConnectionConfig {
  const identity = getEnvironmentMemoryIdentity(env);
  return {
    connectionId: deriveEnvironmentMemoryConnectionId(identity, installationId),
    revision: 1,
    provider: identity.provider,
    url: identity.url,
    collection: identity.collection,
    embedding: identity.embedding,
    credentialMode: 'legacy-environment',
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
export function isEnvironmentMemoryConnectionId(
  connectionId: string,
  installationId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return connectionId === deriveEnvironmentMemoryConnectionId(getEnvironmentMemoryIdentity(env), installationId);
}
