import { afterEach, describe, expect, test } from 'bun:test';
import { getDefaultProjectMemoryOptions, QdrantProjectMemoryStore } from './qdrant.ts';

const originalFetch = globalThis.fetch;
const originalDimension = process.env.CRAFT_QDRANT_DIMENSION;

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

  test('rejects empty search scopes before calling Qdrant', async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return jsonResponse({ result: [] });
    }) as unknown as typeof fetch;

    const store = new QdrantProjectMemoryStore({ enabled: true });
    await expect(store.search({ query: 'memory', scopes: [] })).rejects.toThrow('At least one project memory search scope is required');
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
