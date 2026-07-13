/**
 * Hard limits for the Memory connection/space schema.
 *
 * These are part of the frozen, security-relevant contract: the repository and
 * validators reject any input that exceeds them, and tests assert the exact
 * values. Changing a limit is a schema change and must bump
 * `MEMORY_CONNECTIONS_CONFIG_VERSION`.
 */
export const MEMORY_LIMITS = {
  /** Maximum number of Memory connections stored on disk. */
  MAX_CONNECTIONS: 50,
  /** Maximum number of user-created spaces per connection (excludes the derived Global space). */
  MAX_SPACES_PER_CONNECTION: 200,
  /** Maximum length of a connection display name (after trimming). */
  CONNECTION_NAME_MAX_CHARS: 100,
  /** Maximum length of a space display name (after trimming). */
  SPACE_NAME_MAX_CHARS: 100,
  /** Maximum length of a space's free-text instructions. */
  SPACE_INSTRUCTIONS_MAX_CHARS: 4_000,
  /** Maximum length of a connection URL. */
  URL_MAX_CHARS: 2_048,
  /** Maximum length of a Qdrant collection name. */
  COLLECTION_NAME_MAX_CHARS: 255,
  /** Maximum length of an embedding model identifier. */
  EMBEDDING_MODEL_MAX_CHARS: 200,
  /** Minimum embedding vector dimension. */
  EMBEDDING_DIMENSION_MIN: 1,
  /** Maximum embedding vector dimension (Qdrant's ceiling). */
  EMBEDDING_DIMENSION_MAX: 65_536,
  /** Maximum length of a workspace id used in a space binding. */
  WORKSPACE_ID_MAX_CHARS: 200,
  /** Maximum length of a project id used in a space binding. */
  PROJECT_ID_MAX_CHARS: 200,
} as const;

export type MemoryLimits = typeof MEMORY_LIMITS;
