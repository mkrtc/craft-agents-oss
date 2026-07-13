/**
 * Derivation of a connection's read-only Global space (backend-only).
 *
 * The Global space is never stored; its id is a real, standards-correct
 * RFC-4122 v5 UUID derived from the connection id under a fixed application
 * namespace. This requires `crypto` (via {@link uuidV5}) and is therefore
 * backend-only — kept out of the pure contract modules.
 */

import { uuidV5 } from '../../utils/uuid.ts';
import { MEMORY_GLOBAL_SPACE_NAME, type GlobalMemorySpaceConfig, type MemoryConnectionConfig } from './types.ts';

/**
 * Fixed application namespace UUID for deriving per-connection Global space ids.
 * Stable forever; changing it would re-key every Global space.
 */
export const MEMORY_GLOBAL_SPACE_NAMESPACE = '6f4d3b2a-1c9e-4f7a-8b2d-3e5a6c7d8e9f';

/** Deterministic canonical id of a connection's derived Global space. */
export function deriveGlobalSpaceId(connectionId: string): string {
  return uuidV5(`global:${connectionId}`, MEMORY_GLOBAL_SPACE_NAMESPACE);
}

/** Build the derived, read-only Global space for a connection. */
export function deriveGlobalSpace(connection: MemoryConnectionConfig): GlobalMemorySpaceConfig {
  return {
    kind: 'global',
    spaceId: deriveGlobalSpaceId(connection.connectionId),
    name: MEMORY_GLOBAL_SPACE_NAME,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}
