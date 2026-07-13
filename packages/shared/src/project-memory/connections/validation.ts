/**
 * Strict validation and canonicalization for Memory connection/space contracts.
 *
 * Every validator rejects unknown fields ("strict unknown-field rejection") and
 * enforces the frozen limits. The load-path validator additionally returns a
 * fully rebuilt, canonically-ordered config so nothing from disk is trusted or
 * round-tripped verbatim.
 */

import { isUuid } from '../../utils/uuid.ts';
import { MEMORY_LIMITS } from './limits.ts';
import {
  MEMORY_CONNECTIONS_CONFIG_VERSION,
  MEMORY_GLOBAL_SPACE_NAME,
  type CreateMemoryConnectionInput,
  type CreateMemorySpaceInput,
  type MemoryConnectionConfig,
  type MemoryConnectionsConfig,
  type MemoryEmbeddingIdentity,
  type StoredMemorySpaceConfig,
  type UpdateMemoryConnectionInput,
  type UpdateMemorySpaceInput,
} from './types.ts';

export interface ValidationResult<T> {
  valid: boolean;
  value?: T;
  errors: string[];
}

/** Qdrant collection names / project ids: conservative, injection-safe charset. */
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._-]+$/;

const CONNECTION_KEYS = new Set([
  'connectionId', 'revision', 'provider', 'url', 'collection', 'embedding',
  'name', 'enabled', 'proactiveRemoteSearch', 'spaces', 'createdAt', 'updatedAt',
]);
const EMBEDDING_KEYS = new Set(['model', 'dimension']);
const CONNECTION_MUTABLE_KEYS = new Set(['name', 'enabled', 'proactiveRemoteSearch']);
const CONNECTION_IMMUTABLE_KEYS = new Set([
  'connectionId', 'revision', 'provider', 'url', 'collection', 'embedding', 'spaces', 'createdAt', 'updatedAt',
]);
const SPACE_KEYS_BY_KIND: Record<string, Set<string>> = {
  workspace: new Set(['spaceId', 'kind', 'name', 'instructions', 'createdAt', 'updatedAt', 'workspaceId']),
  project: new Set(['spaceId', 'kind', 'name', 'instructions', 'createdAt', 'updatedAt', 'workspaceId', 'projectId']),
  custom: new Set(['spaceId', 'kind', 'name', 'instructions', 'createdAt', 'updatedAt']),
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extraKeys(obj: Record<string, unknown>, allowed: Set<string>): string[] {
  return Object.keys(obj).filter(key => !allowed.has(key));
}

export function normalizeNameKey(name: string): string {
  return name.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Field validators
// ---------------------------------------------------------------------------

function validateName(value: unknown, field: string, maxChars: number, errors: string[]): string | undefined {
  if (typeof value !== 'string') {
    errors.push(`${field} must be a string`);
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    errors.push(`${field} must not be empty`);
    return undefined;
  }
  if (trimmed.length > maxChars) {
    errors.push(`${field} must be at most ${maxChars} characters`);
    return undefined;
  }
  return trimmed;
}

function validateUrl(value: unknown, errors: string[]): string | undefined {
  if (typeof value !== 'string') {
    errors.push('url must be a string');
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    errors.push('url must not be empty');
    return undefined;
  }
  if (trimmed.length > MEMORY_LIMITS.URL_MAX_CHARS) {
    errors.push(`url must be at most ${MEMORY_LIMITS.URL_MAX_CHARS} characters`);
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    errors.push('url must be a valid absolute URL');
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    errors.push('url must use http or https');
    return undefined;
  }
  return trimmed;
}

function validateCollection(value: unknown, errors: string[]): string | undefined {
  if (typeof value !== 'string') {
    errors.push('collection must be a string');
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    errors.push('collection must not be empty');
    return undefined;
  }
  if (trimmed.length > MEMORY_LIMITS.COLLECTION_NAME_MAX_CHARS) {
    errors.push(`collection must be at most ${MEMORY_LIMITS.COLLECTION_NAME_MAX_CHARS} characters`);
    return undefined;
  }
  if (!IDENTIFIER_PATTERN.test(trimmed)) {
    errors.push('collection may only contain letters, numbers, dot, underscore, and hyphen');
    return undefined;
  }
  return trimmed;
}

function validateBindingId(value: unknown, field: string, maxChars: number, errors: string[]): string | undefined {
  if (typeof value !== 'string') {
    errors.push(`${field} must be a string`);
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    errors.push(`${field} must not be empty`);
    return undefined;
  }
  if (trimmed.length > maxChars) {
    errors.push(`${field} must be at most ${maxChars} characters`);
    return undefined;
  }
  if (!IDENTIFIER_PATTERN.test(trimmed)) {
    errors.push(`${field} may only contain letters, numbers, dot, underscore, and hyphen`);
    return undefined;
  }
  return trimmed;
}

function validateEmbedding(value: unknown, errors: string[]): MemoryEmbeddingIdentity | undefined {
  if (!isPlainObject(value)) {
    errors.push('embedding must be an object');
    return undefined;
  }
  const extras = extraKeys(value, EMBEDDING_KEYS);
  if (extras.length > 0) {
    errors.push(`embedding has unknown field(s): ${extras.join(', ')}`);
    return undefined;
  }
  const model = validateName(value.model, 'embedding.model', MEMORY_LIMITS.EMBEDDING_MODEL_MAX_CHARS, errors);
  const dimension = value.dimension;
  let dimensionOk = true;
  if (typeof dimension !== 'number' || !Number.isInteger(dimension)) {
    errors.push('embedding.dimension must be an integer');
    dimensionOk = false;
  } else if (dimension < MEMORY_LIMITS.EMBEDDING_DIMENSION_MIN || dimension > MEMORY_LIMITS.EMBEDDING_DIMENSION_MAX) {
    errors.push(`embedding.dimension must be between ${MEMORY_LIMITS.EMBEDDING_DIMENSION_MIN} and ${MEMORY_LIMITS.EMBEDDING_DIMENSION_MAX}`);
    dimensionOk = false;
  }
  if (model === undefined || !dimensionOk) return undefined;
  return { model, dimension: dimension as number };
}

function validateInstructions(value: unknown, errors: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    errors.push('instructions must be a string');
    return undefined;
  }
  if (value.length > MEMORY_LIMITS.SPACE_INSTRUCTIONS_MAX_CHARS) {
    errors.push(`instructions must be at most ${MEMORY_LIMITS.SPACE_INSTRUCTIONS_MAX_CHARS} characters`);
    return undefined;
  }
  return value;
}

function validateBoolean(value: unknown, field: string, errors: string[]): boolean | undefined {
  if (typeof value !== 'boolean') {
    errors.push(`${field} must be a boolean`);
    return undefined;
  }
  return value;
}

function validateTimestamp(value: unknown, field: string, errors: string[]): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    errors.push(`${field} must be a non-negative number`);
    return undefined;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Create / update input validators
// ---------------------------------------------------------------------------

const CREATE_CONNECTION_KEYS = new Set(['name', 'url', 'collection', 'embedding', 'enabled', 'proactiveRemoteSearch']);

export function validateCreateMemoryConnectionInput(input: unknown): ValidationResult<CreateMemoryConnectionInput> {
  const errors: string[] = [];
  if (!isPlainObject(input)) {
    return { valid: false, errors: ['connection input must be an object'] };
  }
  const extras = extraKeys(input, CREATE_CONNECTION_KEYS);
  if (extras.length > 0) errors.push(`unknown field(s): ${extras.join(', ')}`);

  const name = validateName(input.name, 'name', MEMORY_LIMITS.CONNECTION_NAME_MAX_CHARS, errors);
  const url = validateUrl(input.url, errors);
  const collection = validateCollection(input.collection, errors);
  const embedding = validateEmbedding(input.embedding, errors);
  const enabled = input.enabled === undefined ? true : validateBoolean(input.enabled, 'enabled', errors);
  const proactiveRemoteSearch = input.proactiveRemoteSearch === undefined
    ? false
    : validateBoolean(input.proactiveRemoteSearch, 'proactiveRemoteSearch', errors);

  if (errors.length > 0 || name === undefined || url === undefined || collection === undefined
    || embedding === undefined || enabled === undefined || proactiveRemoteSearch === undefined) {
    return { valid: false, errors };
  }
  return { valid: true, value: { name, url, collection, embedding, enabled, proactiveRemoteSearch }, errors };
}

export function validateUpdateMemoryConnectionInput(input: unknown): ValidationResult<UpdateMemoryConnectionInput> {
  const errors: string[] = [];
  if (!isPlainObject(input)) {
    return { valid: false, errors: ['connection patch must be an object'] };
  }
  for (const key of Object.keys(input)) {
    if (CONNECTION_MUTABLE_KEYS.has(key)) continue;
    if (CONNECTION_IMMUTABLE_KEYS.has(key)) errors.push(`field "${key}" is immutable and cannot be changed`);
    else errors.push(`unknown field: ${key}`);
  }

  const value: UpdateMemoryConnectionInput = {};
  if (input.name !== undefined) {
    const name = validateName(input.name, 'name', MEMORY_LIMITS.CONNECTION_NAME_MAX_CHARS, errors);
    if (name !== undefined) value.name = name;
  }
  if (input.enabled !== undefined) {
    const enabled = validateBoolean(input.enabled, 'enabled', errors);
    if (enabled !== undefined) value.enabled = enabled;
  }
  if (input.proactiveRemoteSearch !== undefined) {
    const flag = validateBoolean(input.proactiveRemoteSearch, 'proactiveRemoteSearch', errors);
    if (flag !== undefined) value.proactiveRemoteSearch = flag;
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value, errors };
}

export function validateCreateMemorySpaceInput(input: unknown): ValidationResult<CreateMemorySpaceInput> {
  const errors: string[] = [];
  if (!isPlainObject(input)) {
    return { valid: false, errors: ['space input must be an object'] };
  }
  const kind = input.kind;
  if (kind !== 'workspace' && kind !== 'project' && kind !== 'custom') {
    return { valid: false, errors: ['space kind must be one of: workspace, project, custom'] };
  }
  const allowed = new Set(kind === 'workspace'
    ? ['kind', 'name', 'instructions', 'workspaceId']
    : kind === 'project'
      ? ['kind', 'name', 'instructions', 'workspaceId', 'projectId']
      : ['kind', 'name', 'instructions']);
  const extras = extraKeys(input, allowed);
  if (extras.length > 0) errors.push(`unknown field(s): ${extras.join(', ')}`);

  const name = validateName(input.name, 'name', MEMORY_LIMITS.SPACE_NAME_MAX_CHARS, errors);
  const instructions = validateInstructions(input.instructions, errors);

  if (kind === 'workspace') {
    const workspaceId = validateBindingId(input.workspaceId, 'workspaceId', MEMORY_LIMITS.WORKSPACE_ID_MAX_CHARS, errors);
    if (errors.length > 0 || name === undefined || workspaceId === undefined) return { valid: false, errors };
    const value: CreateMemorySpaceInput = { kind, name, workspaceId };
    if (instructions !== undefined) value.instructions = instructions;
    return { valid: true, value, errors };
  }
  if (kind === 'project') {
    const workspaceId = validateBindingId(input.workspaceId, 'workspaceId', MEMORY_LIMITS.WORKSPACE_ID_MAX_CHARS, errors);
    const projectId = validateBindingId(input.projectId, 'projectId', MEMORY_LIMITS.PROJECT_ID_MAX_CHARS, errors);
    if (errors.length > 0 || name === undefined || workspaceId === undefined || projectId === undefined) {
      return { valid: false, errors };
    }
    const value: CreateMemorySpaceInput = { kind, name, workspaceId, projectId };
    if (instructions !== undefined) value.instructions = instructions;
    return { valid: true, value, errors };
  }
  if (errors.length > 0 || name === undefined) return { valid: false, errors };
  const value: CreateMemorySpaceInput = { kind, name };
  if (instructions !== undefined) value.instructions = instructions;
  return { valid: true, value, errors };
}

const UPDATE_SPACE_KEYS = new Set(['name', 'instructions']);

export function validateUpdateMemorySpaceInput(input: unknown): ValidationResult<UpdateMemorySpaceInput> {
  const errors: string[] = [];
  if (!isPlainObject(input)) {
    return { valid: false, errors: ['space patch must be an object'] };
  }
  const extras = extraKeys(input, UPDATE_SPACE_KEYS);
  if (extras.length > 0) errors.push(`unknown field(s): ${extras.join(', ')}`);

  const value: UpdateMemorySpaceInput = {};
  if (input.name !== undefined) {
    const name = validateName(input.name, 'name', MEMORY_LIMITS.SPACE_NAME_MAX_CHARS, errors);
    if (name !== undefined) value.name = name;
  }
  if (input.instructions !== undefined) {
    if (input.instructions === null) {
      value.instructions = null;
    } else {
      const instructions = validateInstructions(input.instructions, errors);
      if (instructions !== undefined) value.instructions = instructions;
    }
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value, errors };
}

// ---------------------------------------------------------------------------
// On-disk config validation (strict, rebuilding)
// ---------------------------------------------------------------------------

function validateStoredSpace(input: unknown, errors: string[]): StoredMemorySpaceConfig | undefined {
  if (!isPlainObject(input)) {
    errors.push('space must be an object');
    return undefined;
  }
  const kind = input.kind;
  if (kind !== 'workspace' && kind !== 'project' && kind !== 'custom') {
    errors.push('stored space kind must be one of: workspace, project, custom');
    return undefined;
  }
  const extras = extraKeys(input, SPACE_KEYS_BY_KIND[kind]!);
  if (extras.length > 0) errors.push(`space has unknown field(s): ${extras.join(', ')}`);

  const spaceId = input.spaceId;
  if (!isUuid(spaceId)) errors.push('spaceId must be a UUID');
  const name = validateName(input.name, 'space.name', MEMORY_LIMITS.SPACE_NAME_MAX_CHARS, errors);
  const instructions = validateInstructions(input.instructions, errors);
  const createdAt = validateTimestamp(input.createdAt, 'space.createdAt', errors);
  const updatedAt = validateTimestamp(input.updatedAt, 'space.updatedAt', errors);

  let workspaceId: string | undefined;
  let projectId: string | undefined;
  if (kind === 'workspace' || kind === 'project') {
    workspaceId = validateBindingId(input.workspaceId, 'space.workspaceId', MEMORY_LIMITS.WORKSPACE_ID_MAX_CHARS, errors);
  }
  if (kind === 'project') {
    projectId = validateBindingId(input.projectId, 'space.projectId', MEMORY_LIMITS.PROJECT_ID_MAX_CHARS, errors);
  }

  if (!isUuid(spaceId) || name === undefined || createdAt === undefined || updatedAt === undefined) return undefined;

  const base = { spaceId, name, createdAt, updatedAt, ...(instructions !== undefined ? { instructions } : {}) };
  if (kind === 'workspace') {
    if (workspaceId === undefined) return undefined;
    return { kind, workspaceId, ...base };
  }
  if (kind === 'project') {
    if (workspaceId === undefined || projectId === undefined) return undefined;
    return { kind, workspaceId, projectId, ...base };
  }
  return { kind, ...base };
}

function validateStoredConnection(input: unknown, errors: string[]): MemoryConnectionConfig | undefined {
  if (!isPlainObject(input)) {
    errors.push('connection must be an object');
    return undefined;
  }
  const extras = extraKeys(input, CONNECTION_KEYS);
  if (extras.length > 0) errors.push(`connection has unknown field(s): ${extras.join(', ')}`);

  const connectionId = input.connectionId;
  if (!isUuid(connectionId)) errors.push('connectionId must be a UUID');

  const revision = input.revision;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) {
    errors.push('revision must be an integer >= 1');
  }

  if (input.provider !== 'qdrant') errors.push('provider must be "qdrant"');

  const url = validateUrl(input.url, errors);
  const collection = validateCollection(input.collection, errors);
  const embedding = validateEmbedding(input.embedding, errors);
  const name = validateName(input.name, 'name', MEMORY_LIMITS.CONNECTION_NAME_MAX_CHARS, errors);
  const enabled = validateBoolean(input.enabled, 'enabled', errors);
  const proactiveRemoteSearch = validateBoolean(input.proactiveRemoteSearch, 'proactiveRemoteSearch', errors);
  const createdAt = validateTimestamp(input.createdAt, 'createdAt', errors);
  const updatedAt = validateTimestamp(input.updatedAt, 'updatedAt', errors);

  const spacesRaw = input.spaces;
  const spaces: StoredMemorySpaceConfig[] = [];
  if (!Array.isArray(spacesRaw)) {
    errors.push('spaces must be an array');
  } else {
    if (spacesRaw.length > MEMORY_LIMITS.MAX_SPACES_PER_CONNECTION) {
      errors.push(`a connection may have at most ${MEMORY_LIMITS.MAX_SPACES_PER_CONNECTION} spaces`);
    }
    const seenSpaceIds = new Set<string>();
    const seenSpaceNames = new Set<string>([normalizeNameKey(MEMORY_GLOBAL_SPACE_NAME)]);
    for (const raw of spacesRaw) {
      const space = validateStoredSpace(raw, errors);
      if (!space) continue;
      if (seenSpaceIds.has(space.spaceId)) errors.push(`duplicate spaceId: ${space.spaceId}`);
      seenSpaceIds.add(space.spaceId);
      const nameKey = normalizeNameKey(space.name);
      if (seenSpaceNames.has(nameKey)) errors.push(`duplicate space name (case-insensitive): ${space.name}`);
      seenSpaceNames.add(nameKey);
      spaces.push(space);
    }
  }

  if (!isUuid(connectionId) || url === undefined || collection === undefined || embedding === undefined
    || name === undefined || enabled === undefined || proactiveRemoteSearch === undefined
    || createdAt === undefined || updatedAt === undefined
    || typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1
    || input.provider !== 'qdrant') {
    return undefined;
  }

  return {
    connectionId,
    revision,
    provider: 'qdrant',
    url,
    collection,
    embedding,
    name,
    enabled,
    proactiveRemoteSearch,
    spaces: sortStoredSpaces(spaces),
    createdAt,
    updatedAt,
  };
}

/** Deterministic ordering for stored spaces: kind, then createdAt, then spaceId. */
export function sortStoredSpaces(spaces: StoredMemorySpaceConfig[]): StoredMemorySpaceConfig[] {
  const kindOrder: Record<string, number> = { workspace: 0, project: 1, custom: 2 };
  return [...spaces].sort((a, b) =>
    (kindOrder[a.kind]! - kindOrder[b.kind]!)
    || (a.createdAt - b.createdAt)
    || a.spaceId.localeCompare(b.spaceId));
}

/** Deterministic ordering for connections: createdAt, then connectionId. */
export function sortConnections(connections: MemoryConnectionConfig[]): MemoryConnectionConfig[] {
  return [...connections].sort((a, b) =>
    (a.createdAt - b.createdAt) || a.connectionId.localeCompare(b.connectionId));
}

/**
 * Strictly validate an on-disk connections config and rebuild it into a
 * canonical, deterministically-ordered document. On any error, returns
 * `valid: false` with an empty default config (caller recovers from backup).
 */
export function validateMemoryConnectionsConfig(input: unknown): ValidationResult<MemoryConnectionsConfig> & { config: MemoryConnectionsConfig } {
  const errors: string[] = [];
  const empty: MemoryConnectionsConfig = { version: MEMORY_CONNECTIONS_CONFIG_VERSION, connections: [] };

  if (!isPlainObject(input)) {
    return { valid: false, errors: ['config must be an object'], config: empty };
  }
  const extras = extraKeys(input, new Set(['version', 'connections']));
  if (extras.length > 0) errors.push(`config has unknown field(s): ${extras.join(', ')}`);
  if (input.version !== MEMORY_CONNECTIONS_CONFIG_VERSION) {
    errors.push(`config version must be ${MEMORY_CONNECTIONS_CONFIG_VERSION}`);
  }

  const connectionsRaw = input.connections;
  const connections: MemoryConnectionConfig[] = [];
  if (!Array.isArray(connectionsRaw)) {
    errors.push('connections must be an array');
  } else {
    if (connectionsRaw.length > MEMORY_LIMITS.MAX_CONNECTIONS) {
      errors.push(`at most ${MEMORY_LIMITS.MAX_CONNECTIONS} connections are allowed`);
    }
    const seenIds = new Set<string>();
    const seenNames = new Set<string>();
    for (const raw of connectionsRaw) {
      const connection = validateStoredConnection(raw, errors);
      if (!connection) continue;
      if (seenIds.has(connection.connectionId)) errors.push(`duplicate connectionId: ${connection.connectionId}`);
      seenIds.add(connection.connectionId);
      const nameKey = normalizeNameKey(connection.name);
      if (seenNames.has(nameKey)) errors.push(`duplicate connection name (case-insensitive): ${connection.name}`);
      seenNames.add(nameKey);
      connections.push(connection);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, config: empty };
  }
  return {
    valid: true,
    errors,
    config: { version: MEMORY_CONNECTIONS_CONFIG_VERSION, connections: sortConnections(connections) },
    value: { version: MEMORY_CONNECTIONS_CONFIG_VERSION, connections: sortConnections(connections) },
  };
}
