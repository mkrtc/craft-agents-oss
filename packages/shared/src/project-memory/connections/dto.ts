/**
 * Secret-free renderer/server DTOs for Memory connections and spaces, plus the
 * mappers that build them from backend config.
 *
 * DTOs never carry API keys. Presence of a key is surfaced as `hasApiKey`
 * (populated by the server from the credential store). Create/patch request
 * DTOs never carry ids for server-generated entities — the server mints
 * `connectionId`/`spaceId`.
 */

import { deriveGlobalSpace } from './repository.ts';
import { sortStoredSpaces } from './validation.ts';
import type {
  MemoryConnectionConfig,
  MemoryEmbeddingIdentity,
  MemoryProvider,
  MemorySpaceConfig,
  MemorySpaceKind,
} from './types.ts';

// ---------------------------------------------------------------------------
// Read DTOs
// ---------------------------------------------------------------------------

export interface MemorySpaceDto {
  spaceId: string;
  name: string;
  instructions?: string;
  kind: MemorySpaceKind;
  workspaceId?: string;
  projectId?: string;
  /** True for the derived Global space (cannot be edited/deleted). */
  readOnly: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryConnectionSummaryDto {
  connectionId: string;
  name: string;
  provider: MemoryProvider;
  url: string;
  collection: string;
  embedding: MemoryEmbeddingIdentity;
  enabled: boolean;
  proactiveRemoteSearch: boolean;
  revision: number;
  createdAt: number;
  updatedAt: number;
  /** Stored spaces + 1 for the derived Global space. */
  spaceCount: number;
  /** Whether an API key exists for this connection (secret-free). */
  hasApiKey: boolean;
  /** Whether this is the synthetic, read-only environment-compat connection. */
  isEnvironment: boolean;
}

export interface MemoryConnectionDetailDto extends MemoryConnectionSummaryDto {
  spaces: MemorySpaceDto[];
}

// ---------------------------------------------------------------------------
// Write request DTOs (ids generated server-side; no secrets)
// ---------------------------------------------------------------------------

export interface CreateMemoryConnectionRequestDto {
  name: string;
  url: string;
  collection: string;
  embedding: MemoryEmbeddingIdentity;
  enabled?: boolean;
  proactiveRemoteSearch?: boolean;
  // NOTE: no apiKey — the secret is set through the credential flow separately.
}

export interface PatchMemoryConnectionRequestDto {
  connectionId: string;
  expectedRevision: number;
  name?: string;
  enabled?: boolean;
  proactiveRemoteSearch?: boolean;
}

export interface DeleteMemoryConnectionRequestDto {
  connectionId: string;
  expectedRevision: number;
}

export type CreateMemorySpaceRequestDto =
  | { connectionId: string; expectedRevision: number; kind: 'workspace'; name: string; instructions?: string; workspaceId: string }
  | { connectionId: string; expectedRevision: number; kind: 'project'; name: string; instructions?: string; workspaceId: string; projectId: string }
  | { connectionId: string; expectedRevision: number; kind: 'custom'; name: string; instructions?: string };

export interface PatchMemorySpaceRequestDto {
  connectionId: string;
  expectedRevision: number;
  spaceId: string;
  name?: string;
  /** `null` clears instructions; omit to leave unchanged. */
  instructions?: string | null;
}

export interface DeleteMemorySpaceRequestDto {
  connectionId: string;
  expectedRevision: number;
  spaceId: string;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

/** Extra, server-known facts that aren't part of the on-disk config. */
export interface MemoryConnectionDtoContext {
  /** Whether a credential exists for this connection. */
  hasApiKey?: boolean;
  /** Whether this connection is the synthetic environment connection. */
  isEnvironment?: boolean;
}

export function toMemorySpaceDto(space: MemorySpaceConfig): MemorySpaceDto {
  const dto: MemorySpaceDto = {
    spaceId: space.spaceId,
    name: space.name,
    kind: space.kind,
    readOnly: space.kind === 'global',
    createdAt: space.createdAt,
    updatedAt: space.updatedAt,
  };
  if (space.instructions !== undefined) dto.instructions = space.instructions;
  if (space.kind === 'workspace') dto.workspaceId = space.workspaceId;
  if (space.kind === 'project') {
    dto.workspaceId = space.workspaceId;
    dto.projectId = space.projectId;
  }
  return dto;
}

export function toMemoryConnectionSummaryDto(
  connection: MemoryConnectionConfig,
  context: MemoryConnectionDtoContext = {},
): MemoryConnectionSummaryDto {
  return {
    connectionId: connection.connectionId,
    name: connection.name,
    provider: connection.provider,
    url: connection.url,
    collection: connection.collection,
    embedding: { model: connection.embedding.model, dimension: connection.embedding.dimension },
    enabled: connection.enabled,
    proactiveRemoteSearch: connection.proactiveRemoteSearch,
    revision: connection.revision,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
    spaceCount: connection.spaces.length + 1,
    hasApiKey: context.hasApiKey ?? false,
    isEnvironment: context.isEnvironment ?? false,
  };
}

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
