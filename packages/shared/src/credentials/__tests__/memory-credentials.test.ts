import { describe, expect, test } from 'bun:test';
import { CredentialManager } from '../manager.ts';
import { accountToCredentialId, credentialIdToAccount, MEMORY_CREDENTIAL_TYPES } from '../types.ts';
import type { CredentialId, StoredCredential } from '../types.ts';

const UUID = '123e4567-e89b-12d3-a456-426614174000';
const OTHER_UUID = '00000000-1111-4222-8333-444444444444';

describe('memory_api_key credential conversion', () => {
  test('MEMORY_CREDENTIAL_TYPES lists memory_api_key', () => {
    expect([...MEMORY_CREDENTIAL_TYPES]).toEqual(['memory_api_key']);
  });

  test('credentialIdToAccount produces memory_api_key::{connectionId}', () => {
    expect(credentialIdToAccount({ type: 'memory_api_key', memoryConnectionId: UUID })).toBe(`memory_api_key::${UUID}`);
  });

  test('credentialIdToAccount canonicalizes a case-variant UUID to lowercase', () => {
    const upper = UUID.toUpperCase();
    expect(credentialIdToAccount({ type: 'memory_api_key', memoryConnectionId: upper })).toBe(`memory_api_key::${UUID}`);
  });

  test('accountToCredentialId rejects a non-canonical (uppercase) account', () => {
    expect(accountToCredentialId(`memory_api_key::${UUID.toUpperCase()}`)).toBeNull();
  });

  test('the account has exactly two "::"-delimited segments (UUID carries no delimiter)', () => {
    const account = credentialIdToAccount({ type: 'memory_api_key', memoryConnectionId: UUID });
    expect(account.split('::')).toHaveLength(2);
  });

  test('round-trips through accountToCredentialId', () => {
    const account = credentialIdToAccount({ type: 'memory_api_key', memoryConnectionId: UUID });
    expect(accountToCredentialId(account)).toEqual({ type: 'memory_api_key', memoryConnectionId: UUID });
  });

  test('converter throws for a missing or non-UUID connection id', () => {
    expect(() => credentialIdToAccount({ type: 'memory_api_key' })).toThrow();
    expect(() => credentialIdToAccount({ type: 'memory_api_key', memoryConnectionId: 'not-a-uuid' })).toThrow();
    expect(() => credentialIdToAccount({ type: 'memory_api_key', memoryConnectionId: 'a::b' })).toThrow();
  });

  test('parser rejects a non-UUID second segment (never falls back to global)', () => {
    expect(accountToCredentialId('memory_api_key::not-a-uuid')).toBeNull();
    expect(accountToCredentialId('memory_api_key::global')).toBeNull();
    expect(accountToCredentialId('memory_api_key')).toBeNull();
  });

  test('does not collide with llm_api_key slug parsing', () => {
    expect(accountToCredentialId('llm_api_key::my-slug')).toEqual({ type: 'llm_api_key', connectionSlug: 'my-slug' });
  });
});

/**
 * Round-trip through the CredentialManager memory helpers, backed by an
 * in-memory store keyed via the REAL account converter. This exercises the full
 * helper → CredentialId → account plumbing (incl. UUID validation and list
 * filtering) deterministically, without touching the encrypted store on disk.
 */
function fakeManager(): { manager: CredentialManager; store: Map<string, StoredCredential> } {
  const store = new Map<string, StoredCredential>();
  const manager = new CredentialManager();
  const api = manager as unknown as {
    get: (id: CredentialId) => Promise<StoredCredential | null>;
    set: (id: CredentialId, cred: StoredCredential) => Promise<void>;
    delete: (id: CredentialId) => Promise<boolean>;
    list: (filter?: Partial<CredentialId>) => Promise<CredentialId[]>;
  };
  api.get = async (id) => store.get(credentialIdToAccount(id)) ?? null;
  api.set = async (id, cred) => { store.set(credentialIdToAccount(id), cred); };
  api.delete = async (id) => store.delete(credentialIdToAccount(id));
  api.list = async (filter) => {
    const ids = [...store.keys()].map(accountToCredentialId).filter((x): x is CredentialId => x !== null);
    if (!filter) return ids;
    return ids.filter(id =>
      (!filter.type || id.type === filter.type)
      && (!filter.memoryConnectionId || id.memoryConnectionId === filter.memoryConnectionId));
  };
  return { manager, store };
}

describe('CredentialManager memory helpers (round-trip)', () => {
  test('set → get → has → list → delete round-trips per connection id', async () => {
    const { manager, store } = fakeManager();

    expect(await manager.hasMemoryApiKey(UUID)).toBe(false);
    await manager.setMemoryApiKey(UUID, 'sk-memory-abc');
    await manager.setMemoryApiKey(OTHER_UUID, 'sk-memory-def');

    // Stored under the connection-scoped account key (no secret in the key).
    expect(store.has(`memory_api_key::${UUID}`)).toBe(true);

    expect(await manager.getMemoryApiKey(UUID)).toBe('sk-memory-abc');
    expect(await manager.hasMemoryApiKey(UUID)).toBe(true);

    const ids = await manager.listMemoryApiKeyConnectionIds();
    expect(ids.sort()).toEqual([UUID, OTHER_UUID].sort());

    expect(await manager.deleteMemoryApiKey(UUID)).toBe(true);
    expect(await manager.getMemoryApiKey(UUID)).toBeNull();
    // The other connection's key is untouched.
    expect(await manager.getMemoryApiKey(OTHER_UUID)).toBe('sk-memory-def');
  });

  test('rejects a non-UUID connection id and empty/whitespace-only key', async () => {
    const { manager } = fakeManager();
    await expect(manager.setMemoryApiKey('not-a-uuid', 'x')).rejects.toThrow();
    await expect(manager.getMemoryApiKey('not-a-uuid')).rejects.toThrow();
    await expect(manager.deleteMemoryApiKey('not-a-uuid')).rejects.toThrow();
    await expect(manager.setMemoryApiKey(UUID, '')).rejects.toThrow();
    await expect(manager.setMemoryApiKey(UUID, '   ')).rejects.toThrow();
    await expect(manager.setMemoryApiKey(UUID, '\t\n')).rejects.toThrow();
  });

  test('case-variant connection ids resolve to the same canonical account', async () => {
    const { manager } = fakeManager();
    await manager.setMemoryApiKey(UUID.toUpperCase(), 'sk-canon');
    expect(await manager.getMemoryApiKey(UUID)).toBe('sk-canon');
    const ids = await manager.listMemoryApiKeyConnectionIds();
    expect(ids).toEqual([UUID]); // canonical lowercase, de-duplicated
  });
});
