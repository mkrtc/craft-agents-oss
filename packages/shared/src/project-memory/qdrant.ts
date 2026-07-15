import { canonicalizeMemoryUrl } from './connections/validation.ts';
import type {
  ProjectMemoryAddInput,
  ProjectMemoryPayload,
  ProjectMemorySearchHit,
  ProjectMemorySearchInput,
  ProjectMemoryStatus,
  ProjectMemoryStore,
} from './types.ts';
import {
  PROJECT_MEMORY_VECTOR_DIMENSION,
  embedProjectMemoryText,
  hashProjectMemoryContent,
  stableProjectMemoryId,
} from './embedding.ts';

export interface QdrantProjectMemoryOptions {
  url?: string;
  apiKey?: string;
  collection?: string;
  dimension?: number;
  enabled?: boolean;
}

interface QdrantSearchPoint {
  id: string | number;
  score: number;
  payload?: ProjectMemoryPayload;
}

interface QdrantCollectionInfo {
  result?: {
    config?: {
      params?: {
        vectors?: { size?: number; distance?: string } | Record<string, { size?: number; distance?: string }>;
      };
    };
  };
}

class QdrantRequestError extends Error {
  constructor(public readonly status: number, public readonly statusText: string, message: string) {
    super(message);
    this.name = 'QdrantRequestError';
  }
}

const DEFAULT_URL = 'http://127.0.0.1:6333';
const DEFAULT_COLLECTION = 'craft_memory';
const DEFAULT_FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_REQUEST_BODY_BYTES = 1_048_576;

export const QDRANT_FETCH_TIMEOUT_MS = DEFAULT_FETCH_TIMEOUT_MS;
export const QDRANT_MAX_REQUEST_BODY_BYTES = DEFAULT_MAX_REQUEST_BODY_BYTES;

function parseProjectMemoryDimension(value: string | undefined): number {
  if (!value) return PROJECT_MEMORY_VECTOR_DIMENSION;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return PROJECT_MEMORY_VECTOR_DIMENSION;
  }
  return parsed;
}

/**
 * Canonicalize a Qdrant URL for transport usage.
 *
 * Falls back to DEFAULT_URL only when caller-provided input is undefined or invalid,
 * keeping deterministic origin normalization in lockstep with validation.
 */
export function canonicalizeProjectMemoryUrl(rawUrl: string | undefined, fallbackUrl: string): string {
  return canonicalizeMemoryUrl(rawUrl) ?? fallbackUrl;
}

/**
 * Enforce transport request body caps for defensive memory safety.
 */
function enforceBodyLimit(body: string): string {
  const bytes = new TextEncoder().encode(body).length;
  if (bytes > DEFAULT_MAX_REQUEST_BODY_BYTES) {
    throw new Error(`Qdrant request body exceeds ${DEFAULT_MAX_REQUEST_BODY_BYTES} bytes`);
  }
  return body;
}

function requireSafeUrl(rawUrl: string): string {
  const canonical = canonicalizeMemoryUrl(rawUrl);
  if (!canonical) {
    throw new Error(`Invalid Qdrant URL: ${rawUrl}`);
  }
  return canonical;
}

export function getDefaultProjectMemoryOptions(): Required<Omit<QdrantProjectMemoryOptions, 'apiKey'>> & { apiKey?: string } {
  return {
    enabled: process.env.CRAFT_PROJECT_MEMORY_ENABLED !== '0',
    url: canonicalizeProjectMemoryUrl(process.env.CRAFT_QDRANT_URL, DEFAULT_URL),
    apiKey: process.env.CRAFT_QDRANT_API_KEY || undefined,
    collection: process.env.CRAFT_QDRANT_COLLECTION || DEFAULT_COLLECTION,
    dimension: parseProjectMemoryDimension(process.env.CRAFT_QDRANT_DIMENSION),
  };
}

function getVectorConfig(info: QdrantCollectionInfo): { size?: number; distance?: string } | undefined {
  const vectors = info.result?.config?.params?.vectors;
  if (!vectors) return undefined;
  if ('size' in vectors || 'distance' in vectors) return vectors as { size?: number; distance?: string };
  return Object.values(vectors)[0];
}

function validateCollectionConfig(info: QdrantCollectionInfo, expectedDimension: number): string | null {
  const vector = getVectorConfig(info);
  if (!vector) return 'Qdrant collection has no vector configuration';
  if (vector.size !== expectedDimension) {
    return `Qdrant collection vector size ${vector.size ?? 'unknown'} does not match expected ${expectedDimension}`;
  }
  if (vector.distance && vector.distance.toLowerCase() !== 'cosine') {
    return `Qdrant collection distance ${vector.distance} does not match expected Cosine`;
  }
  return null;
}

function getEffectiveSearchScopes(input: ProjectMemorySearchInput['scopes']): ProjectMemorySearchInput['scopes'] {
  const effective = input.filter(scope => {
    if (scope.scope === 'global') return true;
    if (scope.scope === 'workspace') return Boolean(scope.workspaceId);
    return Boolean(scope.workspaceId && scope.projectId);
  });
  if (effective.length === 0) {
    throw new Error('At least one effective project memory search scope is required');
  }
  return effective;
}

export class QdrantProjectMemoryStore implements ProjectMemoryStore {
  private collectionReady = false;

  constructor(private readonly options: QdrantProjectMemoryOptions = {}) {}

  private get resolved() {
    const base = getDefaultProjectMemoryOptions();
    return {
      ...base,
      ...this.options,
      url: this.options.url === undefined ? base.url : requireSafeUrl(this.options.url),
    };
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const apiKey = this.resolved.apiKey;
    if (apiKey) headers['api-key'] = apiKey;
    return headers;
  }

  private async request<T>(path: string, init: Omit<RequestInit, 'body'> & { body?: string } = {}): Promise<T> {
    const { url } = this.resolved;
    const safeBody = init.body === undefined ? undefined : enforceBodyLimit(init.body);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(`${url.replace(/\/$/, '')}${path}`, {
        ...init,
        body: safeBody,
        redirect: 'error',
        credentials: 'omit',
        signal: init.signal ?? controller.signal,
        headers: {
          ...this.headers(),
          ...(init?.headers ?? {}),
        },
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new QdrantRequestError(response.status, response.statusText, `Qdrant ${response.status} ${response.statusText}${text ? `: ${text}` : ''}`);
      }
      return await response.json() as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async status(): Promise<ProjectMemoryStatus> {
    const { enabled, url, collection, dimension } = this.resolved;
    if (!enabled) {
      return { enabled, provider: 'qdrant', url, collection, dimension, ok: false, error: 'Project memory is disabled' };
    }
    try {
      const info = await this.request<QdrantCollectionInfo>(`/collections/${encodeURIComponent(collection)}`);
      const configError = validateCollectionConfig(info, dimension);
      if (configError) {
        return { enabled, provider: 'qdrant', url, collection, dimension, ok: false, error: configError };
      }
      return { enabled, provider: 'qdrant', url, collection, dimension, ok: true };
    } catch (error) {
      return {
        enabled,
        provider: 'qdrant',
        url,
        collection,
        dimension,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async ensureCollection(): Promise<void> {
    if (this.collectionReady) return;
    const { collection, dimension } = this.resolved;
    const status = await this.status();
    if (status.ok) {
      this.collectionReady = true;
      return;
    }
    if (status.error && !status.error.includes('Qdrant 404')) {
      throw new Error(status.error);
    }

    await this.request(`/collections/${encodeURIComponent(collection)}`, {
      method: 'PUT',
      body: JSON.stringify({
        vectors: {
          size: dimension,
          distance: 'Cosine',
        },
      }),
    });
    this.collectionReady = true;
  }

  async add(input: ProjectMemoryAddInput): Promise<ProjectMemoryPayload> {
    const { enabled, collection } = this.resolved;
    if (!enabled) throw new Error('Project memory is disabled');
    if (!input.content.trim()) throw new Error('Project memory content is empty');
    if (input.scope === 'project' && !input.projectId) throw new Error('projectId is required for project-scoped memory');
    if ((input.scope === 'workspace' || input.scope === 'project') && !input.workspaceId) {
      throw new Error('workspaceId is required for workspace/project-scoped memory');
    }

    await this.ensureCollection();

    const now = Date.now();
    const contentHash = hashProjectMemoryContent(input.content);
    const id = stableProjectMemoryId([
      input.scope,
      input.workspaceId ?? '',
      input.projectId ?? '',
      input.source,
      input.path ?? '',
      input.sessionId ?? '',
      input.taskSlug ?? '',
      contentHash,
    ]);
    const payload: ProjectMemoryPayload = {
      id,
      scope: input.scope,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      source: input.source,
      title: input.title,
      path: input.path,
      sessionId: input.sessionId,
      taskSlug: input.taskSlug,
      content: input.content,
      contentHash,
      createdAt: now,
      updatedAt: now,
      tags: input.tags,
    };

    await this.request(`/collections/${encodeURIComponent(collection)}/points?wait=true`, {
      method: 'PUT',
      body: JSON.stringify({
        points: [{
          id,
          vector: embedProjectMemoryText([input.title, input.content, input.tags?.join(' ')].filter(Boolean).join('\n'), this.resolved.dimension),
          payload,
        }],
      }),
    });

    return payload;
  }

  async search(input: ProjectMemorySearchInput): Promise<ProjectMemorySearchHit[]> {
    const { enabled, collection, dimension } = this.resolved;
    if (!enabled) throw new Error('Project memory is disabled');
    if (!input.query.trim()) throw new Error('Project memory search query is empty');
    const effectiveScopes = getEffectiveSearchScopes(input.scopes);
    await this.ensureCollection();

    const must: unknown[] = [];
    const should: unknown[] = effectiveScopes.map(scope => ({
      must: [
        { key: 'scope', match: { value: scope.scope } },
        ...(scope.workspaceId ? [{ key: 'workspaceId', match: { value: scope.workspaceId } }] : []),
        ...(scope.projectId ? [{ key: 'projectId', match: { value: scope.projectId } }] : []),
      ],
    }));
    if (input.source) must.push({ key: 'source', match: { value: input.source } });
    for (const tag of input.tags ?? []) {
      must.push({ key: 'tags', match: { value: tag } });
    }

    const filter = {
      ...(must.length ? { must } : {}),
      ...(should.length ? { should } : {}),
    };

    const result = await this.request<{ result: QdrantSearchPoint[] }>(`/collections/${encodeURIComponent(collection)}/points/search`, {
      method: 'POST',
      body: JSON.stringify({
        vector: embedProjectMemoryText(input.query, dimension),
        limit: Math.max(1, Math.min(input.limit ?? 8, 50)),
        with_payload: true,
        filter,
      }),
    });

    return (result.result ?? [])
      .filter(point => point.payload)
      .map(point => ({ score: point.score, payload: point.payload! }));
  }
}

let defaultStore: ProjectMemoryStore | null = null;

export function getProjectMemoryStore(): ProjectMemoryStore {
  defaultStore ??= new QdrantProjectMemoryStore();
  return defaultStore;
}

export function setProjectMemoryStoreForTests(store: ProjectMemoryStore | null): void {
  defaultStore = store;
}
