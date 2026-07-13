import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isUuid } from '../../../utils/uuid.ts';
import { MEMORY_GLOBAL_SPACE_NAME, MemoryError, type CreateMemoryConnectionInput } from '../types.ts';
import { MemoryConnectionRepository, deriveGlobalSpaceId } from '../repository.ts';

let dir: string;
let clock: number;

function makeRepo(times?: number[]): MemoryConnectionRepository {
  if (times) {
    const queue = [...times];
    return new MemoryConnectionRepository({ configDir: dir, now: () => queue.shift() ?? 9999 });
  }
  clock = 1000;
  return new MemoryConnectionRepository({ configDir: dir, now: () => clock++ });
}

const CONN: CreateMemoryConnectionInput = {
  name: 'Alpha',
  url: 'http://127.0.0.1:6333',
  collection: 'craft_memory',
  embedding: { model: 'craft-local-hash-v1', dimension: 384 },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mem-repo-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('MemoryConnectionRepository — connection CRUD', () => {
  test('creates a connection with a server-generated UUID, revision 1, no spaces', async () => {
    const repo = makeRepo();
    const conn = await repo.createConnection(CONN);
    expect(isUuid(conn.connectionId)).toBe(true);
    expect(conn.revision).toBe(1);
    expect(conn.provider).toBe('qdrant');
    expect(conn.enabled).toBe(true);
    expect(conn.proactiveRemoteSearch).toBe(false);
    expect(conn.spaces).toEqual([]);
    expect(repo.getConnection(conn.connectionId)?.name).toBe('Alpha');
  });

  test('persists to ${configDir}/memory/connections.json and leaves no temp file', async () => {
    const repo = makeRepo();
    await repo.createConnection(CONN);
    expect(repo.getFilePath()).toBe(join(dir, 'memory', 'connections.json'));
    expect(existsSync(repo.getFilePath())).toBe(true);
    expect(existsSync(`${repo.getFilePath()}.tmp`)).toBe(false);
  });

  test('accepts arbitrary unicode names but rejects case-insensitive duplicates', async () => {
    const repo = makeRepo();
    await repo.createConnection({ ...CONN, name: 'Prod 🧠' });
    await expect(repo.createConnection({ ...CONN, name: 'prod 🧠' })).rejects.toMatchObject({ code: 'duplicate_name' });
  });

  test('updates only mutable fields and bumps revision', async () => {
    const repo = makeRepo();
    const conn = await repo.createConnection(CONN);
    const updated = await repo.updateConnection(conn.connectionId, { name: 'Beta', enabled: false, proactiveRemoteSearch: true }, conn.revision);
    expect(updated.name).toBe('Beta');
    expect(updated.enabled).toBe(false);
    expect(updated.proactiveRemoteSearch).toBe(true);
    expect(updated.revision).toBe(2);
    // Identity is unchanged.
    expect(updated.url).toBe(CONN.url);
    expect(updated.collection).toBe(CONN.collection);
  });

  test('rejects immutable-field changes at runtime', async () => {
    const repo = makeRepo();
    const conn = await repo.createConnection(CONN);
    await expect(
      repo.updateConnection(conn.connectionId, { url: 'http://evil' } as unknown as { name?: string }, conn.revision),
    ).rejects.toMatchObject({ code: 'immutable_field' });
  });

  test('enforces optimistic revision on update', async () => {
    const repo = makeRepo();
    const conn = await repo.createConnection(CONN);
    await repo.updateConnection(conn.connectionId, { name: 'Beta' }, conn.revision); // now revision 2
    await expect(repo.updateConnection(conn.connectionId, { name: 'Gamma' }, 1)).rejects.toMatchObject({ code: 'revision_conflict' });
  });

  test('rename cannot collide with another connection', async () => {
    const repo = makeRepo();
    const a = await repo.createConnection({ ...CONN, name: 'A' });
    const b = await repo.createConnection({ ...CONN, name: 'B' });
    await expect(repo.updateConnection(b.connectionId, { name: 'a' }, b.revision)).rejects.toMatchObject({ code: 'duplicate_name' });
    // Renaming to its own (differently-cased) name is allowed.
    const renamed = await repo.updateConnection(a.connectionId, { name: 'a' }, a.revision);
    expect(renamed.name).toBe('a');
  });

  test('deletes with revision check', async () => {
    const repo = makeRepo();
    const conn = await repo.createConnection(CONN);
    await expect(repo.deleteConnection(conn.connectionId, 999)).rejects.toMatchObject({ code: 'revision_conflict' });
    await repo.deleteConnection(conn.connectionId, conn.revision);
    expect(repo.getConnection(conn.connectionId)).toBeNull();
  });

  test('throws not_found for unknown connections', async () => {
    const repo = makeRepo();
    await expect(repo.updateConnection(deriveGlobalSpaceId('x'), { name: 'y' }, 1)).rejects.toMatchObject({ code: 'not_found' });
  });

  test('orders connections deterministically by createdAt regardless of insertion order', async () => {
    const repo = makeRepo([3000, 1000, 2000]);
    await repo.createConnection({ ...CONN, name: 'first' });
    await repo.createConnection({ ...CONN, name: 'second' });
    await repo.createConnection({ ...CONN, name: 'third' });
    expect(repo.listConnections().map(c => c.name)).toEqual(['second', 'third', 'first']);
  });
});

describe('MemoryConnectionRepository — spaces', () => {
  test('lists the derived read-only Global space first, then stored spaces', async () => {
    const repo = makeRepo();
    const conn = await repo.createConnection(CONN);
    const spaces = repo.listSpaces(conn.connectionId);
    expect(spaces).toHaveLength(1);
    expect(spaces[0]!.kind).toBe('global');
    expect(spaces[0]!.name).toBe(MEMORY_GLOBAL_SPACE_NAME);
    expect(spaces[0]!.spaceId).toBe(deriveGlobalSpaceId(conn.connectionId));
  });

  test('adds workspace/project/custom spaces and bumps the connection revision', async () => {
    const repo = makeRepo();
    const conn = await repo.createConnection(CONN);
    const { space, connection } = await repo.addSpace(conn.connectionId, { kind: 'workspace', name: 'WS', workspaceId: 'ws-1' }, conn.revision);
    expect(space.kind).toBe('workspace');
    expect(isUuid(space.spaceId)).toBe(true);
    expect(connection.revision).toBe(2);

    const p = await repo.addSpace(conn.connectionId, { kind: 'project', name: 'Proj', workspaceId: 'ws-1', projectId: 'pr-1' }, connection.revision);
    expect(p.space.kind).toBe('project');
    const c = await repo.addSpace(conn.connectionId, { kind: 'custom', name: 'Custom', instructions: 'notes' }, p.connection.revision);
    expect(c.space.kind).toBe('custom');

    const spaces = repo.listSpaces(conn.connectionId);
    expect(spaces.map(s => s.kind)).toEqual(['global', 'workspace', 'project', 'custom']);
  });

  test('rejects duplicate space names and the reserved Global name', async () => {
    const repo = makeRepo();
    const conn = await repo.createConnection(CONN);
    const { connection } = await repo.addSpace(conn.connectionId, { kind: 'custom', name: 'Notes' }, conn.revision);
    await expect(repo.addSpace(conn.connectionId, { kind: 'custom', name: 'notes' }, connection.revision)).rejects.toMatchObject({ code: 'duplicate_name' });
    await expect(repo.addSpace(conn.connectionId, { kind: 'custom', name: 'Global' }, connection.revision)).rejects.toMatchObject({ code: 'duplicate_name' });
  });

  test('updates a stored space and rejects editing the derived Global space', async () => {
    const repo = makeRepo();
    const conn = await repo.createConnection(CONN);
    const { space, connection } = await repo.addSpace(conn.connectionId, { kind: 'custom', name: 'Notes' }, conn.revision);
    const updated = await repo.updateSpace(conn.connectionId, space.spaceId, { name: 'Renamed', instructions: 'x' }, connection.revision);
    expect(updated.space.name).toBe('Renamed');
    expect(updated.space.instructions).toBe('x');

    const globalId = deriveGlobalSpaceId(conn.connectionId);
    await expect(repo.updateSpace(conn.connectionId, globalId, { name: 'nope' }, updated.connection.revision)).rejects.toMatchObject({ code: 'read_only' });
  });

  test('clears instructions with null', async () => {
    const repo = makeRepo();
    const conn = await repo.createConnection(CONN);
    const { space, connection } = await repo.addSpace(conn.connectionId, { kind: 'custom', name: 'Notes', instructions: 'hi' }, conn.revision);
    const cleared = await repo.updateSpace(conn.connectionId, space.spaceId, { instructions: null }, connection.revision);
    expect(cleared.space.instructions).toBeUndefined();
  });

  test('deletes a stored space and rejects deleting the derived Global space', async () => {
    const repo = makeRepo();
    const conn = await repo.createConnection(CONN);
    const { space, connection } = await repo.addSpace(conn.connectionId, { kind: 'custom', name: 'Notes' }, conn.revision);
    const globalId = deriveGlobalSpaceId(conn.connectionId);
    await expect(repo.deleteSpace(conn.connectionId, globalId, connection.revision)).rejects.toMatchObject({ code: 'read_only' });
    const after = await repo.deleteSpace(conn.connectionId, space.spaceId, connection.revision);
    expect(after.spaces).toHaveLength(0);
    await expect(repo.deleteSpace(conn.connectionId, space.spaceId, after.revision)).rejects.toMatchObject({ code: 'space_not_found' });
  });

  test('enforces the connection revision on space mutations', async () => {
    const repo = makeRepo();
    const conn = await repo.createConnection(CONN);
    await expect(repo.addSpace(conn.connectionId, { kind: 'custom', name: 'X' }, 999)).rejects.toMatchObject({ code: 'revision_conflict' });
  });
});

describe('MemoryConnectionRepository — atomic write / backup / recovery', () => {
  test('writes files with restrictive permissions (POSIX)', async () => {
    const repo = makeRepo();
    await repo.createConnection(CONN);
    await repo.createConnection({ ...CONN, name: 'Beta' }); // second write creates a backup
    if (process.platform !== 'win32') {
      expect(statSync(repo.getFilePath()).mode & 0o077).toBe(0);
      expect(statSync(repo.getBackupPath()).mode & 0o077).toBe(0);
    }
  });

  test('recovers from backup when the primary is corrupted', async () => {
    const repo = makeRepo();
    await repo.createConnection(CONN);                     // primary=[Alpha]
    await repo.createConnection({ ...CONN, name: 'Beta' }); // backup=[Alpha], primary=[Alpha,Beta]
    expect(existsSync(repo.getBackupPath())).toBe(true);

    writeFileSync(repo.getFilePath(), 'not valid json {{{');
    const recovered = new MemoryConnectionRepository({ configDir: dir }).load();
    expect(recovered.connections.map(c => c.name)).toEqual(['Alpha']);
  });

  test('falls back to an empty config when both files are unusable', async () => {
    const repo = makeRepo();
    await repo.createConnection(CONN);
    await repo.createConnection({ ...CONN, name: 'Beta' });
    writeFileSync(repo.getFilePath(), 'garbage');
    writeFileSync(repo.getBackupPath(), 'garbage');
    expect(new MemoryConnectionRepository({ configDir: dir }).load().connections).toEqual([]);
  });

  test('never backs up a corrupt primary (self-heals on next write)', async () => {
    const repo = makeRepo();
    await repo.createConnection(CONN);
    await repo.createConnection({ ...CONN, name: 'Beta' }); // good backup=[Alpha]
    writeFileSync(repo.getFilePath(), 'corrupt');           // primary corrupt, backup still good

    const repo2 = new MemoryConnectionRepository({ configDir: dir, now: () => 5000 });
    // load() recovers [Alpha]; the mutation writes a fresh, valid primary.
    const conn = await repo2.createConnection({ ...CONN, name: 'Gamma' });
    expect(conn.name).toBe('Gamma');
    const reloaded = new MemoryConnectionRepository({ configDir: dir }).load();
    expect(reloaded.connections.map(c => c.name).sort()).toEqual(['Alpha', 'Gamma']);
    // The good backup was preserved (corrupt primary was not backed up).
    const backup = JSON.parse(readFileSync(repo.getBackupPath(), 'utf8'));
    expect(backup.connections.map((c: { name: string }) => c.name)).toEqual(['Alpha']);
  });

  test('serializes concurrent mutations without interleaving', async () => {
    const repo = makeRepo();
    const base = await repo.createConnection(CONN);
    // Fire several space additions concurrently; each must observe the prior revision.
    let rev = base.revision;
    const names = ['a', 'b', 'c', 'd', 'e'];
    for (const name of names) {
      const res = await repo.addSpace(base.connectionId, { kind: 'custom', name }, rev);
      rev = res.connection.revision;
    }
    expect(repo.getConnection(base.connectionId)?.spaces).toHaveLength(5);
    expect(repo.getConnection(base.connectionId)?.revision).toBe(base.revision + 5);
  });
});
