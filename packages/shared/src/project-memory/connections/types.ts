/**
 * Strict, versioned contracts for arbitrary-named Qdrant Memory connections and
 * their server-generated spaces.
 *
 * Design invariants (frozen — see also ./limits.ts):
 * - A connection's identity (`provider`, `url`, `collection`, `embedding`) is
 *   immutable once created. Only `name`, `enabled`, and `proactiveRemoteSearch`
 *   may change.
 * - `connectionId` and `spaceId` are server-generated UUIDs.
 * - The Global space is *derived* and read-only; it is never stored on disk.
 *   Stored spaces are Workspace / Project / Custom only.
 * - No space has a per-space `enabled` flag: enablement is expressed by a
 *   session's `enabledMemorySpaceRefs`, not by the space itself.
 * - Config carries no secrets. API keys live only in the credential store,
 *   keyed by `memory_api_key::{connectionId}`.
 *
 * This module is intentionally free of Node built-ins so the types can be
 * imported (type-only) by browser-facing session/protocol contracts.
 */

/** Schema version of `${CONFIG_DIR}/memory/connections.json`. */
export const MEMORY_CONNECTIONS_CONFIG_VERSION = 1 as const;

/** File name (relative to `${CONFIG_DIR}/memory/`) holding the connections config. */
export const MEMORY_CONNECTIONS_FILE = 'connections.json';

/** Display name of every connection's derived, read-only Global space. */
export const MEMORY_GLOBAL_SPACE_NAME = 'Global';

/** Vector-database provider. Currently Qdrant only; part of connection identity. */
export type MemoryProvider = 'qdrant';

/**
 * Immutable embedding identity for a connection.
 *
 * The structured `{ model, dimension }` shape is an approved amendment over the
 * original flat `embeddingIdentity` string. The canonical, immutable identity
 * *key* (equivalent to the legacy `embeddingIdentity` string,
 * `"<model>:<dimension>"`) is derived by `embeddingIdentityKey()` in
 * `./identity.ts` and is what connection-identity comparisons key on.
 */
export interface MemoryEmbeddingIdentity {
  /** Stable identifier of the embedding model/provider (e.g. `craft-local-hash-v1`). */
  model: string;
  /** Vector dimension. Preserved verbatim (arbitrary values are allowed). */
  dimension: number;
}

/**
 * How a connection's API key is provided.
 * - `'none'`: no key (keyless / loopback HTTP).
 * - `'stored-api-key'`: a key is held in the encrypted credential store,
 *   keyed by `memory_api_key::{connectionId}`.
 * - `'legacy-environment'`: the key comes from `CRAFT_QDRANT_API_KEY`. This is
 *   valid **only** on the synthetic, derived environment-compat connection and
 *   is rejected on any stored connection.
 */
export type MemoryCredentialMode = 'none' | 'stored-api-key' | 'legacy-environment';

// ---------------------------------------------------------------------------
// Spaces (discriminated union on `kind`)
// ---------------------------------------------------------------------------

/** All space binding kinds. `global` is derived; the rest are stored. */
export type MemorySpaceKind = 'global' | 'workspace' | 'project' | 'custom';

interface BaseMemorySpaceConfig {
  /** Server-generated UUID. */
  spaceId: string;
  /** Arbitrary bounded display name (case-insensitively unique within a connection). */
  name: string;
  /** Optional free-text guidance surfaced when the space is active. */
  instructions?: string;
  createdAt: number;
  updatedAt: number;
}

/** Derived, read-only space covering everything in a connection. Never stored. */
export interface GlobalMemorySpaceConfig extends BaseMemorySpaceConfig {
  kind: 'global';
}

/** Space bound to a single workspace. */
export interface WorkspaceMemorySpaceConfig extends BaseMemorySpaceConfig {
  kind: 'workspace';
  workspaceId: string;
  /** Whether new memories may be written to this space (non-Global spaces only). */
  writable: boolean;
}

/** Space bound to a single project within a workspace. */
export interface ProjectMemorySpaceConfig extends BaseMemorySpaceConfig {
  kind: 'project';
  workspaceId: string;
  projectId: string;
  /** Whether new memories may be written to this space (non-Global spaces only). */
  writable: boolean;
}

/**
 * Free-standing, user-named space. Optionally bound to a workspace (and,
 * further, a project). `projectId` requires `workspaceId`.
 */
export interface CustomMemorySpaceConfig extends BaseMemorySpaceConfig {
  kind: 'custom';
  workspaceId?: string;
  projectId?: string;
  /** Whether new memories may be written to this space (non-Global spaces only). */
  writable: boolean;
}

/** Spaces that are persisted on disk (Global is excluded — it is derived). */
export type StoredMemorySpaceConfig =
  | WorkspaceMemorySpaceConfig
  | ProjectMemorySpaceConfig
  | CustomMemorySpaceConfig;

/** Any space, including the derived Global space. */
export type MemorySpaceConfig = GlobalMemorySpaceConfig | StoredMemorySpaceConfig;

/**
 * Stable reference to a space within a connection. Used by session persistence
 * (`enabledMemorySpaceRefs`, `memoryWriteTargetRef`) and DTOs.
 */
export interface MemorySpaceRef {
  connectionId: string;
  spaceId: string;
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/**
 * App/backend-scoped Memory connection. Lives in `${CONFIG_DIR}/memory/connections.json`.
 * Contains no secrets.
 */
export interface MemoryConnectionConfig {
  /** Server-generated canonical (lowercase) UUID. Immutable identity. */
  connectionId: string;
  /**
   * Per-connection optimistic-concurrency revision (fine-grained). Starts at 1
   * and increments on every committed mutation *of this connection or its
   * spaces*. Coarse, cross-connection concurrency uses the root `revision`.
   */
  revision: number;
  /** Immutable identity: vector-database provider. */
  provider: MemoryProvider;
  /** Immutable identity: canonical origin URL of the Qdrant instance. */
  url: string;
  /** Immutable identity: Qdrant collection name. */
  collection: string;
  /** Immutable identity: embedding model + dimension. */
  embedding: MemoryEmbeddingIdentity;
  /** How the connection's API key is provided. */
  credentialMode: MemoryCredentialMode;
  /** Mutable: arbitrary bounded, case-insensitively unique display name. */
  name: string;
  /** Mutable: whether the connection is active. */
  enabled: boolean;
  /** Mutable: whether to proactively search this remote connection. */
  proactiveRemoteSearch: boolean;
  /** User-created spaces (Workspace / Project / Custom). Global is derived, not stored. */
  spaces: StoredMemorySpaceConfig[];
  createdAt: number;
  updatedAt: number;
}

/** Root document persisted to `connections.json`. */
export interface MemoryConnectionsConfig {
  version: typeof MEMORY_CONNECTIONS_CONFIG_VERSION;
  /**
   * Root optimistic-concurrency revision. Increments on **every** committed
   * mutation (connection create/update/delete, space add/update/delete). Starts
   * at 0 for a fresh/empty config. Connection create/delete guard on this;
   * future list snapshots / change events also key on it.
   */
  revision: number;
  /**
   * Backend-local installation identifier (canonical UUID). Generated once for
   * this backend installation and used as the UUIDv5 namespace for deriving the
   * synthetic environment-compat connection id. Never synchronized between
   * installations.
   */
  installationId: string;
  connections: MemoryConnectionConfig[];
}

// ---------------------------------------------------------------------------
// Session selection contract
// ---------------------------------------------------------------------------

/**
 * How a session's memory space selection was decided.
 * - `'explicit'`: the user explicitly picked spaces.
 * - absent: derived/default behavior.
 */
export type MemorySelectionMode = 'explicit';

// ---------------------------------------------------------------------------
// Mutation inputs (server generates ids/timestamps/revisions)
// ---------------------------------------------------------------------------

/** Input for creating a connection. `connectionId`/`revision`/timestamps are server-set. */
export interface CreateMemoryConnectionInput {
  name: string;
  url: string;
  collection: string;
  embedding: MemoryEmbeddingIdentity;
  /** Defaults to `true`. */
  enabled?: boolean;
  /** Defaults to `false`. */
  proactiveRemoteSearch?: boolean;
}

/** Patchable connection fields. Identity fields are intentionally absent. */
export interface UpdateMemoryConnectionInput {
  name?: string;
  enabled?: boolean;
  proactiveRemoteSearch?: boolean;
}

/**
 * Input for creating a space. `spaceId`/timestamps are server-set. Global is not
 * creatable. `writable` defaults to `true`. For `custom`, `projectId` requires
 * `workspaceId`.
 */
export type CreateMemorySpaceInput =
  | { kind: 'workspace'; name: string; instructions?: string; writable?: boolean; workspaceId: string }
  | { kind: 'project'; name: string; instructions?: string; writable?: boolean; workspaceId: string; projectId: string }
  | { kind: 'custom'; name: string; instructions?: string; writable?: boolean; workspaceId?: string; projectId?: string };

/** Patchable space fields. Binding (`kind`/ids) is immutable; `writable` is not. */
export interface UpdateMemorySpaceInput {
  name?: string;
  /** Pass `null` to clear instructions; omit to leave unchanged. */
  instructions?: string | null;
  /** Toggle whether new memories may be written to this space. */
  writable?: boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type MemoryErrorCode =
  | 'invalid_config'
  | 'invalid_input'
  | 'not_found'
  | 'space_not_found'
  | 'duplicate_name'
  | 'immutable_field'
  | 'revision_conflict'
  | 'limit_exceeded'
  | 'read_only'
  | 'storage_error';

/** Typed error for all Memory repository/validation failures. */
export class MemoryError extends Error {
  readonly code: MemoryErrorCode;
  readonly details?: unknown;
  constructor(code: MemoryErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'MemoryError';
    this.code = code;
    this.details = details;
  }
}
