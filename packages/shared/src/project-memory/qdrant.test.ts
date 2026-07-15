import { afterEach, describe, expect, test } from 'bun:test';
import {
  QDRANT_MAX_REQUEST_BODY_BYTES,
  getDefaultProjectMemoryOptions,
  QdrantProjectMemoryStore,
} from './qdrant.ts';

const originalFetch = globalThis.fetch;
const originalDimension = process.env.CRAFT_QDRANT_DIMENSION;
const originalUrl = process.env.CRAFT_QDRANT_URL;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDimension === undefined) delete process.env.CRAFT_QDRANT_DIMENSION;
  else process.env.CRAFT_QDRANT_DIMENSION = originalDimension;
  if (originalUrl === undefined) delete process.env.CRAFT_QDRANT_URL;
  else process.env.CRAFT_QDRANT_URL = originalUrl;
});

describe('QdrantProjectMemoryStore', () => {
  test('falls back to default dimension for invalid env values', () => {
    process.env.CRAFT_QDRANT_DIMENSION = 'not-a-number';
    expect(getDefaultProjectMemoryOptions().dimension).toBe(384);

    process.env.CRAFT_QDRANT_DIMENSION = '-1';
    expect(getDefaultProjectMemoryOptions().dimension).toBe(384);

    process.env.CRAFT_QDRANT_DIMENSION = '768';
    expect(getDefaultProjectMemoryOptions().dimension).toBe(768);
  });

  test('canonicalizes trailing-dot qdrant URL in defaults', () => {
    process.env.CRAFT_QDRANT_URL = 'https://example.com.:443';
    expect(getDefaultProjectMemoryOptions().url).toBe('https://example.com/');
  });

  test('rejects qdrant URL with embedded credentials in explicit store config', async () => {
    delete process.env.CRAFT_QDRANT_URL;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return jsonResponse({ result: { config: { params: { vectors: { size: 384, distance: 'Cosine' } } } } });
    }) as unknown as typeof fetch;

    const store = new QdrantProjectMemoryStore({
      enabled: true,
      url: 'https://user:pass@example.com',
      dimension: 384,
    });

    await expect(store.status()).rejects.toThrow('Invalid Qdrant URL: https://user:pass@example.com');
    expect(fetchCalled).toBe(false);
  });

  test('enforces request body limits before point upsert request', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse({
        result: {
          config: {
            params: {
              vectors: { size: 384, distance: 'Cosine' },
            },
          },
        },
      });
    }) as unknown as typeof fetch;

    const store = new QdrantProjectMemoryStore({ enabled: true, dimension: 384 });
    await expect(
      store.add({
        scope: 'global',
        source: 'manual-note',
        content: 'x'.repeat(QDRANT_MAX_REQUEST_BODY_BYTES + 1),
      }),
    ).rejects.toThrow('Qdrant request body exceeds');
    expect(calls).toBe(1);
  });

  test('rejects request with unsafe redirect/credential handling options', async () => {
    let lastRequest: RequestInit | undefined;
    globalThis.fetch = ((_, init) => {
      lastRequest = init;
      return Promise.resolve(
        jsonResponse({
          result: {
            config: {
              params: {
                vectors: { size: 384, distance: 'Cosine' },
              },
            },
          },
        }),
      );
    }) as unknown as typeof fetch;

    const store = new QdrantProjectMemoryStore({ enabled: true, dimension: 384 });
    const status = await store.status();
    expect(status.ok).toBe(true);
    expect(lastRequest?.redirect).toBe('error');
    expect(lastRequest?.credentials).toBe('omit');
  });

  test('rejects empty and malformed search scopes before calling Qdrant', async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return jsonResponse({ result: [] });
    }) as unknown as typeof fetch;

    const store = new QdrantProjectMemoryStore({ enabled: true });
    await expect(store.search({ query: 'memory', scopes: [] })).rejects.toThrow('At least one effective project memory search scope is required');
    await expect(store.search({ query: 'memory', scopes: [{ scope: 'workspace' }] })).rejects.toThrow('At least one effective project memory search scope is required');
    await expect(store.search({ query: 'memory', scopes: [{ scope: 'project', workspaceId: 'ws' }] })).rejects.toThrow('At least one effective project memory search scope is required');
    expect(fetchCalled).toBe(false);
  });

  test('reports existing collection vector dimension mismatch', async () => {
    globalThis.fetch = (async () => jsonResponse({
      result: {
        config: {
          params: {
            vectors: { size: 128, distance: 'Cosine' },
          },
        },
      },
    })) as unknown as typeof fetch;

    const store = new QdrantProjectMemoryStore({ enabled: true, dimension: 384 });
    const status = await store.status();
    expect(status.ok).toBe(false);
    expect(status.error).toContain('does not match expected 384');
  });

  test('reports existing collection distance mismatch', async () => {
    globalThis.fetch = (async () => jsonResponse({
      result: {
        config: {
          params: {
            vectors: { size: 384, distance: 'Dot' },
          },
        },
      },
    })) as unknown as typeof fetch;

    const store = new QdrantProjectMemoryStore({ enabled: true, dimension: 384 });
    const status = await store.status();
    expect(status.ok).toBe(false);
    expect(status.error).toContain('does not match expected Cosine');
  });

  test('does not auto-create collection when reachable collection has incompatible config', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse({
        result: {
          config: {
            params: {
              vectors: { size: 128, distance: 'Cosine' },
            },
          },
        },
      });
    }) as unknown as typeof fetch;

    const store = new QdrantProjectMemoryStore({ enabled: true, dimension: 384 });
    await expect(store.add({
      scope: 'global',
      source: 'manual-note',
      content: 'memory',
    })).rejects.toThrow('does not match expected 384');
    expect(calls).toBe(1);
  });
});
