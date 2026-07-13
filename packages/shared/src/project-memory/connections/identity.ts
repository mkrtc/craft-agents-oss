/**
 * Canonical, immutable identity keys for Memory connections.
 *
 * Pure module (no Node built-ins). These keys are the stable, comparison-safe
 * string forms of the immutable connection identity. They are what duplicate-
 * detection and store-routing key on, and they are equivalent to the original
 * flat `embeddingIdentity` string that the structured `{ model, dimension }`
 * shape replaced.
 */

import type { MemoryEmbeddingIdentity } from './types.ts';

/**
 * Canonical embedding-identity key, equivalent to the legacy `embeddingIdentity`
 * string: `"<model>:<dimension>"`. Immutable once a connection is created.
 */
export function embeddingIdentityKey(embedding: MemoryEmbeddingIdentity): string {
  return `${embedding.model}:${embedding.dimension}`;
}

/** The immutable identity fields of a connection, in canonical form. */
export interface MemoryConnectionIdentity {
  provider: string;
  /** Canonical origin URL (already normalized by validation). */
  url: string;
  collection: string;
  embedding: MemoryEmbeddingIdentity;
}

/**
 * Canonical connection-identity key: provider + canonical origin + collection +
 * embedding identity. Two connections with equal keys address the same managed
 * store identity (they may still be distinct profiles with distinct ids).
 *
 * Uses `\u0000` as a separator so no component can forge a boundary.
 */
export function connectionIdentityKey(identity: MemoryConnectionIdentity): string {
  return [
    identity.provider,
    identity.url,
    identity.collection,
    embeddingIdentityKey(identity.embedding),
  ].join('\u0000');
}
