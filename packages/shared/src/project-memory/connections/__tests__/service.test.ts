/**
 * Service-layer tests for coordinated Memory connection + credential lifecycle.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialManager } from '../../../credentials/manager.ts';
import type { CredentialBackend } from '../../../credentials/backends/types.ts';
import { accountToCredentialId, credentialIdToAccount, type CredentialId, type StoredCredential } from '../../../credentials/types.ts';
import { MemoryConnectionRepository } from '../repository.ts';
import { CreateMemoryConnectionServiceInput, MemoryConnectionService, UpdateMemoryConnectionServiceInput } from '../service.ts';
import type { CreateMemoryConnectionInput } from '../types.ts';

interface BackendFaultConfig {
  failSet?: (id: CredentialId) => boolean;
  failGet?: (id: CredentialId) => boolean;
  failDelete?: (id: CredentialId) => boolean;
}

interface ServiceHarness {
  repo: MemoryConnectionRepository;
  service: MemoryConnectionService;
  manager: CredentialManager;
  store: Map<string, StoredCredential>;
}

let dir: string;

function makeHarness(faults: BackendFaultConfig = {}): ServiceHarness {
  const repo = new MemoryConnectionRepository({ configDir: dir });
  const store = new Map<string, StoredCredential>();
  const backend: CredentialBackend = {
    name: 'memory-service-test-backend',
    priority: 100,
    async isAvailable(): Promise<boolean> {
      return true;
    },
    async get(id: CredentialId): Promise<StoredCredential | null> {
      if (faults.failGet?.(id)) {
        throw new Error(`injected get failure for ${credentialIdToAccount(id)}`);
      }
      return store.get(credentialIdToAccount(id)) ?? null;
    },
    async set(id: CredentialId, credential: StoredCredential): Promise<void> {
      if (faults.failSet?.(id)) {
        throw new Error(`injected set failure for ${credentialIdToAccount(id)}`);
      }
      store.set(credentialIdToAccount(id), credential);
    },
    async delete(id: CredentialId): Promise<boolean> {
      if (faults.failDelete?.(id)) {
        throw new Error(`injected delete failure for ${credentialIdToAccount(id)}`);
      }
      return store.delete(credentialIdToAccount(id));
    },
    deleteSync(id: CredentialId): boolean {
      return store.delete(credentialIdToAccount(id));
    },
    async list(filter?: Partial<CredentialId>): Promise<CredentialId[]> {
      const ids = [...store.keys()].map(accountToCredentialId).filter((x): x is CredentialId => x !== null);
      if (!filter) return ids;
      return ids.filter(id =>
        (!filter.type || id.type === filter.type)
        && (!filter.memoryConnectionId || id.memoryConnectionId === filter.memoryConnectionId),
      );
    },
  };

  const manager = new CredentialManager({ backends: [backend] });
  const service = new MemoryConnectionService({ repository: repo, credentialManager: manager });

  return { repo, service, manager, store };
}

const CONN: CreateMemoryConnectionInput = {
  name: 'Alpha',
  url: 'http://127.0.0.1:6333',
  collection: 'craft_memory',
  embedding: { model: 'craft-local-hash-v1', dimension: 384 },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mem-service-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function createConnection(
  service: MemoryConnectionService,
  input: CreateMemoryConnectionServiceInput = { ...CONN },
) {
  return service.createConnection(input);
}

function makeUpdate(
  connectionId: string,
  expectedRevision: number,
  patch: Omit<UpdateMemoryConnectionServiceInput, 'connectionId' | 'expectedRevision'>,
): UpdateMemoryConnectionServiceInput {
  return { connectionId, expectedRevision, ...patch };
}

describe('MemoryConnectionService — create', () => {
  test('create writes no secret into DTO/config when apiKey is omitted', async () => {
    const { repo, service, store } = makeHarness();

    const summary = await createConnection(service, CONN);

    const loaded = repo.getConnection(summary.connectionId)!;
    expect(summary.hasApiKey).toBe(false);
    expect(loaded.credentialMode).toBe('none');
    expect('apiKey' in summary).toBe(false);
    expect(store.size).toBe(0);
  });

  test('create with apiKey persists secret only in credential storage and returns hasApiKey true', async () => {
    const { repo, service, manager } = makeHarness();

    const summary = await createConnection(service, { ...CONN, apiKey: '  sk-live-alpha  ' });

    const loaded = repo.getConnection(summary.connectionId)!;
    expect(summary.hasApiKey).toBe(true);
    expect(loaded.credentialMode).toBe('stored-api-key');
    expect('apiKey' in summary).toBe(false);
    expect(await manager.getMemoryApiKey(summary.connectionId)).toBe('sk-live-alpha');
  });

  test('create rejects blank apiKey before persisting either config or credentials', async () => {
    const { repo, service } = makeHarness();

    await expect(createConnection(service, { ...CONN, apiKey: '   ' })).rejects.toMatchObject({
      code: 'validation_error',
    });

    expect(repo.listConnections()).toHaveLength(0);
  });

  test('create rolls back config if credential write fails', async () => {
    const { repo, service } = makeHarness({
      failSet: id => id.type === 'memory_api_key',
    });

    await expect(createConnection(service, { ...CONN, apiKey: 'sk-live-beta' })).rejects.toMatchObject({
      code: 'credential_error',
    });

    expect(repo.listConnections()).toHaveLength(0);
  });
});

describe('MemoryConnectionService — patch/update', () => {
  test('update without apiKey uses updated config while preserving existing key state', async () => {
    const { repo, service, manager } = makeHarness();

    const created = await createConnection(service, { ...CONN, apiKey: 'sk-initial' });
    const updated = await service.patchConnection(makeUpdate(created.connectionId, created.revision, {
      name: 'Alpha Renamed',
    }));

    expect(updated.name).toBe('Alpha Renamed');
    expect(updated.hasApiKey).toBe(true);
    expect(await manager.getMemoryApiKey(created.connectionId)).toBe('sk-initial');
    expect(repo.getConnection(created.connectionId)!.revision).toBe(2);
  });

  test('patch does not update key when config patch fails; returns validation/config error', async () => {
    const { service, repo, manager } = makeHarness();

    const created = await createConnection(service, { ...CONN, apiKey: 'sk-initial' });
    const staleRevision = created.revision + 1;

    await expect(service.patchConnection(makeUpdate(created.connectionId, staleRevision, {
      name: 'Should fail',
      apiKey: 'sk-updated',
    }))).rejects.toMatchObject({ code: 'config_error' });

    expect(repo.getConnection(created.connectionId)).not.toBeNull();
    expect(await manager.getMemoryApiKey(created.connectionId)).toBe('sk-initial');
  });

  test('if config patch succeeds but apiKey write fails, config remains and key is unchanged', async () => {
    const { service, repo, manager } = makeHarness({
      failSet: id => id.type === 'memory_api_key',
    });

    const created = await service.createConnection(CONN);
    await expect(service.patchConnection(makeUpdate(created.connectionId, created.revision, {
      name: 'Edited',
      apiKey: 'sk-bad-update',
    }))).rejects.toMatchObject({ code: 'credential_error' });

    expect(repo.getConnection(created.connectionId)?.name).toBe('Edited');
    expect(await manager.hasMemoryApiKey(created.connectionId)).toBe(false);
  });

  test('patch rejects blank apiKey before mutating config', async () => {
    const { repo, service } = makeHarness();

    const created = await service.createConnection(CONN);
    await expect(service.patchConnection(makeUpdate(created.connectionId, created.revision, {
      name: 'Edited',
      apiKey: '   ',
    }))).rejects.toMatchObject({ code: 'validation_error' });
    expect(repo.getConnection(created.connectionId)?.name).toBe('Alpha');
  });
});

describe('MemoryConnectionService — delete', () => {
  test('delete removes both config and credential when both succeed', async () => {
    const { repo, service, manager } = makeHarness();

    const created = await createConnection(service, { ...CONN, apiKey: 'sk-to-delete' });
    const rootBefore = repo.getRootRevision();

    await service.deleteConnection(created.connectionId, rootBefore);

    expect(repo.getConnection(created.connectionId)).toBeNull();
    expect(await manager.hasMemoryApiKey(created.connectionId)).toBe(false);
  });

  test('delete fails when credential delete fails and does not remove config', async () => {
    const { repo, service, manager } = makeHarness({
      failDelete: id => id.type === 'memory_api_key',
    });

    const created = await service.createConnection({ ...CONN, apiKey: 'sk-to-delete' });
    const rootBefore = repo.getRootRevision();

    await expect(service.deleteConnection(created.connectionId, rootBefore)).rejects.toMatchObject({
      code: 'credential_error',
    });

    expect(repo.getConnection(created.connectionId)).not.toBeNull();
    expect(await manager.getMemoryApiKey(created.connectionId)).toBe('sk-to-delete');
  });

  test('delete restores API key when config delete fails after credential deletion', async () => {
    const { repo, service, manager } = makeHarness();

    const first = await createConnection(service, { ...CONN, apiKey: 'sk-stay' });
    const staleRoot = repo.getRootRevision();

    // Make config root change so delete uses stale revision and fails.
    await createConnection(service, { ...CONN, name: 'Second' });

    await expect(service.deleteConnection(first.connectionId, staleRoot)).rejects.toMatchObject({
      code: 'config_error',
    });

    expect(repo.getConnection(first.connectionId)).not.toBeNull();
    expect(await manager.getMemoryApiKey(first.connectionId)).toBe('sk-stay');
  });
});
