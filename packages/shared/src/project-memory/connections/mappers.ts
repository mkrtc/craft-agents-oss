/**
 * Backend-only DTO mappers that require deriving the Global space id (crypto).
 * Kept separate from the pure `./dto.ts` so DTO *types* stay renderer-safe.
 */

import { deriveGlobalSpace } from './global-space.ts';
import {
  toMemoryConnectionSummaryDto,
  toMemorySpaceDto,
  type MemoryConnectionDetailDto,
  type MemoryConnectionDtoContext,
  type MemoryConnectionsSnapshotDto,
} from './dto.ts';
import { sortStoredSpaces } from './validation.ts';
import type { MemoryConnectionConfig, MemorySpaceConfig } from './types.ts';

/** Full detail DTO, listing the derived read-only Global space first. */
export function toMemoryConnectionDetailDto(
  connection: MemoryConnectionConfig,
  context: MemoryConnectionDtoContext = {},
): MemoryConnectionDetailDto {
  const spaces: MemorySpaceConfig[] = [deriveGlobalSpace(connection), ...sortStoredSpaces(connection.spaces)];
  return {
    ...toMemoryConnectionSummaryDto(connection, context),
    spaces: spaces.map(toMemorySpaceDto),
  };
}

/** Snapshot DTO carrying the root revision alongside connection summaries. */
export function toMemoryConnectionsSnapshotDto(
  revision: number,
  connections: MemoryConnectionConfig[],
  contextFor?: (connection: MemoryConnectionConfig) => MemoryConnectionDtoContext,
): MemoryConnectionsSnapshotDto {
  return {
    revision,
    connections: connections.map(c => toMemoryConnectionSummaryDto(c, contextFor?.(c))),
  };
}
