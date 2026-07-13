/**
 * CONFIG_DIR-backed repository for Memory connections and their spaces.
 *
 * Storage: `${CONFIG_DIR}/memory/connections.json` (+ `.bak` backup).
 *
 * Guarantees:
 * - **Serialized process-local mutation** — every write goes through a promise
 *   chain, so concurrent callers never interleave a read-modify-write.
 * - **Atomic write + backup + recovery** — writes go to a temp file then rename;
 *   the last-known-good primary is preserved as `.bak`; a corrupt primary is
 *   recovered from `.bak`, and a corrupt pair falls back to an empty config.
 * - **Restrictive permissions where supported** — dir `0o700`, files `0o600`.
 * - **Deterministic ordering** — connections and spaces are sorted canonically.
 * - **Optimistic revision** — mutations on an existing connection require the
 *   caller's `expectedRevision` to match; the revision is bumped on success.
 * - **Explicit CRUD** — no whole-config replacement API is exposed.
 * - **No secrets** — API keys are never read or written here.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from '../../config/paths.ts';
import { safeJsonParse } from '../../utils/files.ts';
import { deterministicUuid, randomUuid } from '../../utils/uuid.ts';
import { MEMORY_LIMITS } from './limits.ts';
import {
  MEMORY_CONNECTIONS_CONFIG_VERSION,
  MEMORY_CONNECTIONS_FILE,
  MEMORY_GLOBAL_SPACE_NAME,
  MemoryError,
  type CreateMemoryConnectionInput,
  type CreateMemorySpaceInput,
  type GlobalMemorySpaceConfig,
  type MemoryConnectionConfig,
  type MemoryConnectionsConfig,
  type MemorySpaceConfig,
  type StoredMemorySpaceConfig,
  type UpdateMemoryConnectionInput,
  type UpdateMemorySpaceInput,
} from './types.ts';
import {
  normalizeNameKey,
  sortConnections,
  sortStoredSpaces,
  validateCreateMemoryConnectionInput,
  validateCreateMemorySpaceInput,
  validateMemoryConnectionsConfig,
  validateUpdateMemoryConnectionInput,
  validateUpdateMemorySpaceInput,
} from './validation.ts';

export interface MemoryConnectionRepositoryOptions {
  /** Root config dir (defaults to CONFIG_DIR). Overridable for tests. */
  configDir?: string;
  /** Clock, overridable for tests. */
  now?: () => number;
}

/** Result of a space create/update mutation. */
export interface MemorySpaceMutationResult {
  connection: MemoryConnectionConfig;
  space: StoredMemorySpaceConfig;
}

function emptyConfig(): MemoryConnectionsConfig {
  return { version: MEMORY_CONNECTIONS_CONFIG_VERSION, connections: [] };
}

export class MemoryConnectionRepository {
  private readonly dir: string;
  private readonly filePath: string;
  private readonly backupPath: string;
  private readonly now: () => number;
  private mutationChain: Promise<unknown> = Promise.resolve();

  constructor(options: MemoryConnectionRepositoryOptions = {}) {
    this.dir = join(options.configDir ?? CONFIG_DIR, 'memory');
    this.filePath = join(this.dir, MEMORY_CONNECTIONS_FILE);
    this.backupPath = `${this.filePath}.bak`;
    this.now = options.now ?? (() => Date.now());
  }

  getFilePath(): string {
    return this.filePath;
  }

  getBackupPath(): string {
    return this.backupPath;
  }

  // -------------------------------------------------------------------------
  // Reads (synchronous, always reflect on-disk state)
  // -------------------------------------------------------------------------

  /** Load the validated, canonical config, recovering from backup if needed. */
  load(): MemoryConnectionsConfig {
    const primary = this.tryLoad(this.filePath);
    if (primary) return primary;
    const backup = this.tryLoad(this.backupPath);
    if (backup) return backup;
    return emptyConfig();
  }

  listConnections(): MemoryConnectionConfig[] {
    return this.load().connections;
  }

  getConnection(connectionId: string): MemoryConnectionConfig | null {
    return this.load().connections.find(c => c.connectionId === connectionId) ?? null;
  }

  /** Spaces for a connection, with the derived read-only Global space first. */
  listSpaces(connectionId: string): MemorySpaceConfig[] {
    const connection = this.requireConnection(this.load(), connectionId);
    return [deriveGlobalSpace(connection), ...connection.spaces];
  }

  getSpace(connectionId: string, spaceId: string): MemorySpaceConfig | null {
    const connection = this.getConnection(connectionId);
    if (!connection) return null;
    const global = deriveGlobalSpace(connection);
    if (global.spaceId === spaceId) return global;
    return connection.spaces.find(s => s.spaceId === spaceId) ?? null;
  }

  /** Deterministic id of a connection's derived Global space. */
  getGlobalSpaceId(connectionId: string): string {
    return deriveGlobalSpaceId(connectionId);
  }

  private tryLoad(path: string): MemoryConnectionsConfig | null {
    try {
      if (!existsSync(path)) return null;
      const parsed = safeJsonParse(readFileSync(path, 'utf8'));
      const result = validateMemoryConnectionsConfig(parsed);
      return result.valid ? result.config : null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Connection CRUD (serialized)
  // -------------------------------------------------------------------------

  createConnection(input: CreateMemoryConnectionInput): Promise<MemoryConnectionConfig> {
    return this.runExclusive(() => {
      const validation = validateCreateMemoryConnectionInput(input);
      if (!validation.valid || !validation.value) {
        throw new MemoryError('invalid_input', validation.errors.join('; '), validation.errors);
      }
      const value = validation.value;
      const config = this.load();
      if (config.connections.length >= MEMORY_LIMITS.MAX_CONNECTIONS) {
        throw new MemoryError('limit_exceeded', `at most ${MEMORY_LIMITS.MAX_CONNECTIONS} connections are allowed`);
      }
      assertConnectionNameAvailable(config, value.name);

      const timestamp = this.now();
      const connection: MemoryConnectionConfig = {
        connectionId: randomUuid(),
        revision: 1,
        provider: 'qdrant',
        url: value.url,
        collection: value.collection,
        embedding: value.embedding,
        name: value.name,
        enabled: value.enabled ?? true,
        proactiveRemoteSearch: value.proactiveRemoteSearch ?? false,
        spaces: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      config.connections.push(connection);
      this.persist(config);
      return connection;
    });
  }

  updateConnection(
    connectionId: string,
    patch: UpdateMemoryConnectionInput,
    expectedRevision: number,
  ): Promise<MemoryConnectionConfig> {
    return this.runExclusive(() => {
      const validation = validateUpdateMemoryConnectionInput(patch);
      if (!validation.valid || !validation.value) {
        // Distinguish immutable-field attempts for a clearer error code.
        const immutable = validation.errors.some(e => e.includes('immutable'));
        throw new MemoryError(immutable ? 'immutable_field' : 'invalid_input', validation.errors.join('; '), validation.errors);
      }
      const value = validation.value;
      const config = this.load();
      const connection = this.requireConnection(config, connectionId);
      assertRevision(connection, expectedRevision);

      if (value.name !== undefined && normalizeNameKey(value.name) !== normalizeNameKey(connection.name)) {
        assertConnectionNameAvailable(config, value.name, connectionId);
      }
      if (value.name !== undefined) connection.name = value.name;
      if (value.enabled !== undefined) connection.enabled = value.enabled;
      if (value.proactiveRemoteSearch !== undefined) connection.proactiveRemoteSearch = value.proactiveRemoteSearch;
      connection.revision += 1;
      connection.updatedAt = this.now();

      this.persist(config);
      return connection;
    });
  }

  deleteConnection(connectionId: string, expectedRevision: number): Promise<void> {
    return this.runExclusive(() => {
      const config = this.load();
      const connection = this.requireConnection(config, connectionId);
      assertRevision(connection, expectedRevision);
      config.connections = config.connections.filter(c => c.connectionId !== connectionId);
      this.persist(config);
    });
  }

  // -------------------------------------------------------------------------
  // Space CRUD (serialized; bumps the parent connection's revision)
  // -------------------------------------------------------------------------

  addSpace(
    connectionId: string,
    input: CreateMemorySpaceInput,
    expectedRevision: number,
  ): Promise<MemorySpaceMutationResult> {
    return this.runExclusive(() => {
      const validation = validateCreateMemorySpaceInput(input);
      if (!validation.valid || !validation.value) {
        throw new MemoryError('invalid_input', validation.errors.join('; '), validation.errors);
      }
      const value = validation.value;
      const config = this.load();
      const connection = this.requireConnection(config, connectionId);
      assertRevision(connection, expectedRevision);
      if (connection.spaces.length >= MEMORY_LIMITS.MAX_SPACES_PER_CONNECTION) {
        throw new MemoryError('limit_exceeded', `a connection may have at most ${MEMORY_LIMITS.MAX_SPACES_PER_CONNECTION} spaces`);
      }
      assertSpaceNameAvailable(connection, value.name);

      const timestamp = this.now();
      const base = {
        spaceId: randomUuid(),
        name: value.name,
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(value.instructions !== undefined ? { instructions: value.instructions } : {}),
      };
      const space: StoredMemorySpaceConfig = value.kind === 'workspace'
        ? { kind: 'workspace', workspaceId: value.workspaceId, ...base }
        : value.kind === 'project'
          ? { kind: 'project', workspaceId: value.workspaceId, projectId: value.projectId, ...base }
          : { kind: 'custom', ...base };

      connection.spaces = sortStoredSpaces([...connection.spaces, space]);
      connection.revision += 1;
      connection.updatedAt = timestamp;
      this.persist(config);
      return { connection, space };
    });
  }

  updateSpace(
    connectionId: string,
    spaceId: string,
    patch: UpdateMemorySpaceInput,
    expectedRevision: number,
  ): Promise<MemorySpaceMutationResult> {
    return this.runExclusive(() => {
      const validation = validateUpdateMemorySpaceInput(patch);
      if (!validation.valid || !validation.value) {
        throw new MemoryError('invalid_input', validation.errors.join('; '), validation.errors);
      }
      const value = validation.value;
      const config = this.load();
      const connection = this.requireConnection(config, connectionId);
      assertRevision(connection, expectedRevision);
      if (spaceId === deriveGlobalSpaceId(connectionId)) {
        throw new MemoryError('read_only', 'the derived Global space is read-only');
      }
      const space = connection.spaces.find(s => s.spaceId === spaceId);
      if (!space) throw new MemoryError('space_not_found', `space not found: ${spaceId}`);

      if (value.name !== undefined && normalizeNameKey(value.name) !== normalizeNameKey(space.name)) {
        assertSpaceNameAvailable(connection, value.name, spaceId);
      }
      const timestamp = this.now();
      if (value.name !== undefined) space.name = value.name;
      if (value.instructions === null) delete space.instructions;
      else if (value.instructions !== undefined) space.instructions = value.instructions;
      space.updatedAt = timestamp;

      connection.spaces = sortStoredSpaces(connection.spaces);
      connection.revision += 1;
      connection.updatedAt = timestamp;
      this.persist(config);
      return { connection, space };
    });
  }

  deleteSpace(
    connectionId: string,
    spaceId: string,
    expectedRevision: number,
  ): Promise<MemoryConnectionConfig> {
    return this.runExclusive(() => {
      const config = this.load();
      const connection = this.requireConnection(config, connectionId);
      assertRevision(connection, expectedRevision);
      if (spaceId === deriveGlobalSpaceId(connectionId)) {
        throw new MemoryError('read_only', 'the derived Global space is read-only');
      }
      const before = connection.spaces.length;
      connection.spaces = connection.spaces.filter(s => s.spaceId !== spaceId);
      if (connection.spaces.length === before) {
        throw new MemoryError('space_not_found', `space not found: ${spaceId}`);
      }
      connection.revision += 1;
      connection.updatedAt = this.now();
      this.persist(config);
      return connection;
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requireConnection(config: MemoryConnectionsConfig, connectionId: string): MemoryConnectionConfig {
    const connection = config.connections.find(c => c.connectionId === connectionId);
    if (!connection) throw new MemoryError('not_found', `connection not found: ${connectionId}`);
    return connection;
  }

  /** Serialize mutations process-locally via a promise chain. */
  private runExclusive<T>(fn: () => T): Promise<T> {
    const run = this.mutationChain.then(() => fn());
    // Keep the chain alive even if a mutation rejects.
    this.mutationChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private persist(config: MemoryConnectionsConfig): void {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    }
    // Preserve the last-known-good primary as backup (never back up corrupt data).
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf8');
        if (validateMemoryConnectionsConfig(safeJsonParse(raw)).valid) {
          writeFileSync(this.backupPath, raw, { mode: 0o600 });
        }
      }
    } catch {
      // Best-effort backup; a failure here must not block the primary write.
    }
    const canonical: MemoryConnectionsConfig = {
      version: MEMORY_CONNECTIONS_CONFIG_VERSION,
      connections: sortConnections(config.connections.map(c => ({ ...c, spaces: sortStoredSpaces(c.spaces) }))),
    };
    this.atomicWrite(this.filePath, `${JSON.stringify(canonical, null, 2)}\n`);
  }

  private atomicWrite(path: string, data: string): void {
    const tmp = `${path}.tmp`;
    try {
      writeFileSync(tmp, data, { mode: 0o600 });
      // Windows rename fails if the target exists; remove it first.
      try { unlinkSync(path); } catch { /* ignore if absent */ }
      renameSync(tmp, path);
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* ignore */ }
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for reuse by DTO mappers / environment builder)
// ---------------------------------------------------------------------------

/** Deterministic id of a connection's derived Global space. */
export function deriveGlobalSpaceId(connectionId: string): string {
  return deterministicUuid([connectionId, 'space', 'global']);
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

function assertRevision(connection: MemoryConnectionConfig, expectedRevision: number): void {
  if (connection.revision !== expectedRevision) {
    throw new MemoryError(
      'revision_conflict',
      `revision conflict: expected ${expectedRevision}, found ${connection.revision}`,
      { expected: expectedRevision, actual: connection.revision },
    );
  }
}

function assertConnectionNameAvailable(config: MemoryConnectionsConfig, name: string, exceptId?: string): void {
  const key = normalizeNameKey(name);
  const clash = config.connections.some(c => c.connectionId !== exceptId && normalizeNameKey(c.name) === key);
  if (clash) throw new MemoryError('duplicate_name', `a connection named "${name}" already exists`);
}

function assertSpaceNameAvailable(connection: MemoryConnectionConfig, name: string, exceptSpaceId?: string): void {
  const key = normalizeNameKey(name);
  if (key === normalizeNameKey(MEMORY_GLOBAL_SPACE_NAME)) {
    throw new MemoryError('duplicate_name', `"${MEMORY_GLOBAL_SPACE_NAME}" is reserved by the derived Global space`);
  }
  const clash = connection.spaces.some(s => s.spaceId !== exceptSpaceId && normalizeNameKey(s.name) === key);
  if (clash) throw new MemoryError('duplicate_name', `a space named "${name}" already exists in this connection`);
}
