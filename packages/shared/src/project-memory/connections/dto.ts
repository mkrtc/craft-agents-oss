/**
 * Secret-free renderer/server DTOs for Memory connections and spaces.
 *
 * Pure module (no Node built-ins, no repository import) so the DTO *types* are
 * renderer-safe. The crypto-dependent detail mapper (which derives the Global
 * space id) lives in the backend-only `./mappers.ts`.
 *
 * DTOs never carry API keys. Presence of a key is surfaced as `hasApiKey`
 * (populated by the server from the credential store). Create/patch request
 * DTOs never carry ids for server-generated entities — the server mints
 * `connectionId`/`spaceId`.
 */

import type {
  MemoryConnectionConfig,
  MemoryCredentialMode,
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
  /** Whether new memories may be written here. Absent for the Global space. */
  writable?: boolean;
  /** True for the derived Global space (cannot be edited/deleted/written). */
  readOnly: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryConnectionSummaryDto {
  connectionId: string;
  name: string;
  provider: MemoryProvider;
  /** Canonical, safe origin URL (no userinfo/query/fragment/path). */
  url: string;
  collection: string;
  embedding: MemoryEmbeddingIdentity;
  credentialMode: MemoryCredentialMode;
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

/** Snapshot of the connection list plus the root revision (for future events/lists). */
export interface MemoryConnectionsSnapshotDto {
  revision: number;
  connections: MemoryConnectionSummaryDto[];
}

// ---------------------------------------------------------------------------
// Write request DTOs (ids generated server-side; no secrets)
// ---------------------------------------------------------------------------

export interface CreateMemoryConnectionRequestDto {
  expectedRootRevision: number;
  name: string;
  url: string;
  collection: string;
  embedding: MemoryEmbeddingIdentity;
  enabled?: boolean;
  proactiveRemoteSearch?: boolean;
  /** Write-only secret. Stored in credentials, never returned in config/DTO responses. */
  apiKey?: string;
}

export interface PatchMemoryConnectionRequestDto {
  connectionId: string;
  expectedRevision: number;
  name?: string;
  enabled?: boolean;
  proactiveRemoteSearch?: boolean;
  /** Write-only secret operation: omit keeps existing key, null deletes, string sets/replaces. */
  apiKey?: string | null;
}

export interface DeleteMemoryConnectionRequestDto {
  connectionId: string;
  expectedRootRevision: number;
}

export interface CheckMemoryConnectionRequestDto {
  url: string;
  collection: string;
  embedding: MemoryEmbeddingIdentity;
  /** Write-only secret used only for this check; never persisted by the check endpoint. */
  apiKey?: string;
}

export interface CheckMemoryConnectionResultDto {
  ok: boolean;
  state: 'ready' | 'not-initialized' | 'config-mismatch' | 'unreachable' | 'error';
  message: string;
  url: string;
  collection: string;
  dimension: number;
}

export type CreateMemorySpaceRequestDto =
  | { connectionId: string; expectedRevision: number; kind: 'workspace'; name: string; instructions?: string; writable?: boolean; workspaceId: string }
  | { connectionId: string; expectedRevision: number; kind: 'project'; name: string; instructions?: string; writable?: boolean; workspaceId: string; projectId: string }
  | { connectionId: string; expectedRevision: number; kind: 'custom'; name: string; instructions?: string; writable?: boolean; workspaceId?: string; projectId?: string };

export interface PatchMemorySpaceRequestDto {
  connectionId: string;
  expectedRevision: number;
  spaceId: string;
  name?: string;
  /** `null` clears instructions; omit to leave unchanged. */
  instructions?: string | null;
  writable?: boolean;
}

export interface DeleteMemorySpaceRequestDto {
  connectionId: string;
  expectedRevision: number;
  spaceId: string;
}

// ---------------------------------------------------------------------------
// Pure mappers (no crypto; the detail mapper lives in ./mappers.ts)
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
  if (space.kind !== 'global') dto.writable = space.writable;
  if (space.kind === 'workspace') dto.workspaceId = space.workspaceId;
  if (space.kind === 'project') {
    dto.workspaceId = space.workspaceId;
    dto.projectId = space.projectId;
  }
  if (space.kind === 'custom') {
    if (space.workspaceId !== undefined) dto.workspaceId = space.workspaceId;
    if (space.projectId !== undefined) dto.projectId = space.projectId;
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
    credentialMode: connection.credentialMode,
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
