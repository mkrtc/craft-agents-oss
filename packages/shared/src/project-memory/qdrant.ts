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

const DEFAULT_URL = 'http://127.0.0.1:6333';
const DEFAULT_COLLECTION = 'craft_memory';

export function getDefaultProjectMemoryOptions(): Required<Omit<QdrantProjectMemoryOptions, 'apiKey'>> & { apiKey?: string } {
  return {
    enabled: process.env.CRAFT_PROJECT_MEMORY_ENABLED !== '0',
    url: process.env.CRAFT_QDRANT_URL || DEFAULT_URL,
    apiKey: process.env.CRAFT_QDRANT_API_KEY || undefined,
    collection: process.env.CRAFT_QDRANT_COLLECTION || DEFAULT_COLLECTION,
    dimension: Number(process.env.CRAFT_QDRANT_DIMENSION || PROJECT_MEMORY_VECTOR_DIMENSION),
  };
}

export class QdrantProjectMemoryStore implements ProjectMemoryStore {
  private collectionReady = false;

  constructor(private readonly options: QdrantProjectMemoryOptions = {}) {}

  private get resolved() {
    return { ...getDefaultProjectMemoryOptions(), ...this.options };
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const apiKey = this.resolved.apiKey;
    if (apiKey) headers['api-key'] = apiKey;
    return headers;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const { url } = this.resolved;
    const res = await fetch(`${url.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: {
        ...this.headers(),
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Qdrant ${res.status} ${res.statusText}${text ? `: ${text}` : ''}`);
    }
    return await res.json() as T;
  }

  async status(): Promise<ProjectMemoryStatus> {
    const { enabled, url, collection, dimension } = this.resolved;
    if (!enabled) {
      return { enabled, provider: 'qdrant', url, collection, dimension, ok: false, error: 'Project memory is disabled' };
    }
    try {
      await this.request(`/collections/${encodeURIComponent(collection)}`);
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
    await this.ensureCollection();

    const must: unknown[] = [];
    const should: unknown[] = input.scopes.map(scope => ({
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
