/**
 * CONFIG_DIR-backed repository for Memory connections and their spaces.
 *
 * Storage: `${CONFIG_DIR}/memory/connections.json` (+ `.bak` backup).
 *
 * Guarantees:
 * - **Serialized process-local mutation** — every write goes through a promise
 *   chain, so concurrent callers never interleave a read-modify-write.
 * - **Durable, symlink-safe atomic writes** — data is written to a unique,
 *   same-dir, exclusive (`O_EXCL`) `0600` temp file, `fsync`ed, then renamed
 *   directly over the target (no unlink gap); the directory is `fsync`ed where
 *   supported. Symlinked primary/backup/temp targets are refused, never
 *   followed. The backup goes through its own unique temp + fsync + rename.
 * - **No silent data loss** — a missing config is a fresh/empty config, but a
 *   *present-but-unreadable/corrupt* primary AND backup surface an explicit
 *   `invalid_config` error rather than silently resetting to empty. A corrupt
 *   primary with a good backup recovers from the backup.
 * - **Restrictive permissions** — dir `0o700`, files `0o600`; existing dir/files
 *   are repaired toward those modes where POSIX-supported.
 * - **Root + per-connection revisions** — the root `revision` bumps on every
 *   committed mutation (connection create/delete guard on it); each connection
 *   also keeps a fine-grained `revision` (update / space mutations guard on it).
 * - **Explicit CRUD** — no whole-config replacement API is exposed.
 * - **No secrets** — API keys are never read or written here.
 */

import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'fs';
import { basename, join } from 'path';
import { CONFIG_DIR } from '../../config/paths.ts';
import { safeJsonParse } from '../../utils/files.ts';
import { randomUuid } from '../../utils/uuid.ts';
import { deriveGlobalSpace, deriveGlobalSpaceId } from './global-space.ts';
import { MEMORY_LIMITS } from './limits.ts';
import {
  MEMORY_CONNECTIONS_CONFIG_VERSION,
  MEMORY_CONNECTIONS_FILE,
  MEMORY_GLOBAL_SPACE_NAME,
  MemoryError,
  type CreateMemoryConnectionInput,
  type CreateMemorySpaceInput,
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

// Re-export the Global-space derivation so existing importers keep working.
export { deriveGlobalSpace, deriveGlobalSpaceId } from './global-space.ts';

/** Upper bound on the config file size we will read (bounded reads). */
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;

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

type ReadResult =
  | { status: 'ok'; config: MemoryConnectionsConfig }
  | { status: 'missing' }
  | { status: 'error'; reason: string };

export class MemoryConnectionRepository {
  private readonly dir: string;
  private readonly filePath: string;
  private readonly backupPath: string;
  private readonly now: () => number;
  private mutationChain: Promise<unknown> = Promise.resolve();
  /** Stable ephemeral installationId for a fresh (unwritten) config on this instance. */
  private pendingInstallationId: string | null = null;

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

  /**
   * Load the validated, canonical config. Recovers a corrupt primary from the
   * backup. Throws `invalid_config` if a present config is unreadable/corrupt
   * (both primary and backup) — it NEVER silently resets to empty.
   */
  load(): MemoryConnectionsConfig {
    const primary = this.tryReadConfig(this.filePath);
    if (primary.status === 'ok') return primary.config;
    const backup = this.tryReadConfig(this.backupPath);
    if (backup.status === 'ok') return backup.config;
    if (primary.status === 'missing' && backup.status === 'missing') {
      return this.freshEmptyConfig();
    }
    throw new MemoryError(
      'invalid_config',
      `memory connections config is unreadable or corrupt (primary: ${describe(primary)}, backup: ${describe(backup)}); refusing to reset`,
      { primary: describe(primary), backup: describe(backup) },
    );
  }

  getRootRevision(): number {
    return this.load().revision;
  }

  getInstallationId(): string {
    return this.load().installationId;
  }

  /** Ensure the installationId is generated and persisted (stable across restarts). */
  ensureInstallationId(): Promise<string> {
    return this.runExclusive(() => {
      const existed = existsSync(this.filePath);
      const config = this.load();
      if (!existed) this.persist(config);
      return config.installationId;
    });
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

  private freshEmptyConfig(): MemoryConnectionsConfig {
    this.pendingInstallationId ??= randomUuid();
    return { version: MEMORY_CONNECTIONS_CONFIG_VERSION, revision: 0, installationId: this.pendingInstallationId, connections: [] };
  }

  private tryReadConfig(path: string): ReadResult {
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { status: 'missing' };
      return { status: 'error', reason: `stat failed: ${code ?? 'unknown'}` };
    }
    if (stat.isSymbolicLink()) return { status: 'error', reason: 'target is a symlink' };
    if (!stat.isFile()) return { status: 'error', reason: 'target is not a regular file' };
    if (stat.size > MAX_CONFIG_BYTES) return { status: 'error', reason: 'file exceeds size limit' };

    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { status: 'missing' };
      return { status: 'error', reason: `read failed: ${code ?? 'unknown'}` };
    }

    let parsed: unknown;
    try {
      parsed = safeJsonParse(raw);
    } catch {
      return { status: 'error', reason: 'invalid JSON' };
    }
    const result = validateMemoryConnectionsConfig(parsed, { deriveGlobalSpaceId });
    if (!result.valid) return { status: 'error', reason: `invalid schema: ${result.errors[0] ?? 'unknown'}` };
    return { status: 'ok', config: result.config };
  }

  // -------------------------------------------------------------------------
  // Connection CRUD (serialized). Create/delete guard on the ROOT revision.
  // -------------------------------------------------------------------------

  createConnection(input: CreateMemoryConnectionInput, expectedRootRevision: number): Promise<MemoryConnectionConfig> {
    return this.runExclusive(() => {
      const validation = validateCreateMemoryConnectionInput(input);
      if (!validation.valid || !validation.value) {
        throw new MemoryError('invalid_input', validation.errors.join('; '), validation.errors);
      }
      const value = validation.value;
      const config = this.load();
      assertRootRevision(config, expectedRootRevision);
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
        credentialMode: 'none',
        name: value.name,
        enabled: value.enabled ?? true,
        proactiveRemoteSearch: value.proactiveRemoteSearch ?? false,
        spaces: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      config.connections.push(connection);
      config.revision += 1;
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
        const immutable = validation.errors.some(e => e.includes('immutable'));
        throw new MemoryError(immutable ? 'immutable_field' : 'invalid_input', validation.errors.join('; '), validation.errors);
      }
      const value = validation.value;
      const config = this.load();
      const connection = this.requireConnection(config, connectionId);
      assertRevision(connection, expectedRevision);

      const nameChanges = value.name !== undefined && value.name !== connection.name;
      const enabledChanges = value.enabled !== undefined && value.enabled !== connection.enabled;
      const proactiveChanges = value.proactiveRemoteSearch !== undefined && value.proactiveRemoteSearch !== connection.proactiveRemoteSearch;

      // Canonical no-op patch: nothing actually changes → no revision/timestamp
      // bump and no write.
      if (!nameChanges && !enabledChanges && !proactiveChanges) {
        return connection;
      }

      if (nameChanges) {
        if (normalizeNameKey(value.name!) !== normalizeNameKey(connection.name)) {
          assertConnectionNameAvailable(config, value.name!, connectionId);
        }
        connection.name = value.name!;
      }
      if (enabledChanges) connection.enabled = value.enabled!;
      if (proactiveChanges) connection.proactiveRemoteSearch = value.proactiveRemoteSearch!;
      connection.revision += 1;
      connection.updatedAt = this.now();
      config.revision += 1;

      this.persist(config);
      return connection;
    });
  }

  deleteConnection(connectionId: string, expectedRootRevision: number): Promise<void> {
    return this.runExclusive(() => {
      const config = this.load();
      assertRootRevision(config, expectedRootRevision);
      this.requireConnection(config, connectionId);
      config.connections = config.connections.filter(c => c.connectionId !== connectionId);
      config.revision += 1;
      this.persist(config);
    });
  }

  // -------------------------------------------------------------------------
  // Space CRUD (serialized; bumps parent connection + root revision)
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
      const writable = value.writable ?? true;
      const base = {
        spaceId: randomUuid(),
        name: value.name,
        writable,
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(value.instructions !== undefined ? { instructions: value.instructions } : {}),
      };
      const space: StoredMemorySpaceConfig = value.kind === 'workspace'
        ? { kind: 'workspace', workspaceId: value.workspaceId, ...base }
        : value.kind === 'project'
          ? { kind: 'project', workspaceId: value.workspaceId, projectId: value.projectId, ...base }
          : {
            kind: 'custom',
            ...(value.workspaceId !== undefined ? { workspaceId: value.workspaceId } : {}),
            ...(value.projectId !== undefined ? { projectId: value.projectId } : {}),
            ...base,
          };

      connection.spaces = sortStoredSpaces([...connection.spaces, space]);
      connection.revision += 1;
      connection.updatedAt = timestamp;
      config.revision += 1;
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

      const nameChanges = value.name !== undefined && value.name !== space.name;
      const instructionsChanges = value.instructions !== undefined
        && (value.instructions === null ? space.instructions !== undefined : value.instructions !== space.instructions);
      const writableChanges = value.writable !== undefined && value.writable !== space.writable;

      // Canonical no-op patch: no revision/timestamp bump, no write.
      if (!nameChanges && !instructionsChanges && !writableChanges) {
        return { connection, space };
      }

      if (nameChanges && normalizeNameKey(value.name!) !== normalizeNameKey(space.name)) {
        assertSpaceNameAvailable(connection, value.name!, spaceId);
      }
      const timestamp = this.now();
      if (nameChanges) space.name = value.name!;
      if (instructionsChanges) {
        if (value.instructions === null) delete space.instructions;
        else space.instructions = value.instructions;
      }
      if (writableChanges) space.writable = value.writable!;
      space.updatedAt = timestamp;

      connection.spaces = sortStoredSpaces(connection.spaces);
      connection.revision += 1;
      connection.updatedAt = timestamp;
      config.revision += 1;
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
      config.revision += 1;
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
    this.ensureDirSecure();
    // Preserve the last-known-good primary as backup (never back up corrupt data).
    const current = this.tryReadConfig(this.filePath);
    if (current.status === 'ok') {
      this.atomicWriteSecure(this.backupPath, serialize(current.config));
      this.repairFileMode(this.backupPath);
    }
    const canonical: MemoryConnectionsConfig = {
      version: MEMORY_CONNECTIONS_CONFIG_VERSION,
      revision: config.revision,
      installationId: config.installationId,
      connections: sortConnections(config.connections.map(c => ({ ...c, spaces: sortStoredSpaces(c.spaces) }))),
    };
    this.atomicWriteSecure(this.filePath, serialize(canonical));
    this.repairFileMode(this.filePath);
  }

  private ensureDirSecure(): void {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    } else if (process.platform !== 'win32') {
      try { chmodSync(this.dir, 0o700); } catch { /* best effort */ }
    }
  }

  private repairFileMode(path: string): void {
    if (process.platform === 'win32') return;
    try { chmodSync(path, 0o600); } catch { /* best effort */ }
  }

  private assertNotSymlink(path: string): void {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        throw new MemoryError('invalid_config', `refusing to write through a symlink: ${path}`);
      }
    } catch (error) {
      if (error instanceof MemoryError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return; // target absent → safe to create
      throw new MemoryError('invalid_config', `cannot stat ${path}: ${code ?? 'unknown'}`);
    }
  }

  /**
   * Write `data` to `path` durably and symlink-safely: unique same-dir exclusive
   * `0600` temp → fsync → direct atomic rename over the target (no unlink gap) →
   * fsync dir (where supported).
   */
  private atomicWriteSecure(path: string, data: string): void {
    this.assertNotSymlink(path);
    const tmp = join(this.dir, `.${basename(path)}.${randomUuid()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(tmp, 'wx', 0o600); // O_CREAT | O_EXCL | O_WRONLY, mode 0600
      writeSync(fd, data, null, 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, path);
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
      try { unlinkSync(tmp); } catch { /* ignore */ }
      throw error;
    }
    this.fsyncDir();
  }

  private fsyncDir(): void {
    if (process.platform === 'win32') return; // directory fsync unsupported
    let dfd: number | undefined;
    try {
      dfd = openSync(this.dir, 'r');
      fsyncSync(dfd);
    } catch {
      // Best effort: some filesystems reject directory fsync.
    } finally {
      if (dfd !== undefined) { try { closeSync(dfd); } catch { /* ignore */ } }
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function serialize(config: MemoryConnectionsConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function describe(result: ReadResult): string {
  return result.status === 'error' ? result.reason : result.status;
}

function assertRootRevision(config: MemoryConnectionsConfig, expectedRootRevision: number): void {
  if (config.revision !== expectedRootRevision) {
    throw new MemoryError(
      'revision_conflict',
      `root revision conflict: expected ${expectedRootRevision}, found ${config.revision}`,
      { expected: expectedRootRevision, actual: config.revision },
    );
  }
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
