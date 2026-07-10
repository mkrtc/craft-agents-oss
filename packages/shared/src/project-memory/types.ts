export type ProjectMemoryScope = 'global' | 'workspace' | 'project';

export type ProjectMemoryKind =
  | 'file'
  | 'session'
  | 'task'
  | 'decision'
  | 'preference'
  | 'manual-note';

export interface ProjectMemoryPayload {
  id: string;
  scope: ProjectMemoryScope;
  workspaceId?: string;
  projectId?: string;
  source: ProjectMemoryKind;
  title?: string;
  path?: string;
  sessionId?: string;
  taskSlug?: string;
  content: string;
  contentHash: string;
  createdAt: number;
  updatedAt: number;
  tags?: string[];
}

export interface ProjectMemoryAddInput {
  scope: ProjectMemoryScope;
  workspaceId?: string;
  projectId?: string;
  source: ProjectMemoryKind;
  title?: string;
  path?: string;
  sessionId?: string;
  taskSlug?: string;
  content: string;
  tags?: string[];
}

export interface ProjectMemorySearchInput {
  query: string;
  scopes: Array<{
    scope: ProjectMemoryScope;
    workspaceId?: string;
    projectId?: string;
  }>;
  limit?: number;
  source?: ProjectMemoryKind;
  tags?: string[];
}

export interface ProjectMemorySearchHit {
  score: number;
  payload: ProjectMemoryPayload;
}

export interface ProjectMemoryStatus {
  enabled: boolean;
  provider: 'qdrant';
  url: string;
  collection: string;
  dimension: number;
  ok: boolean;
  error?: string;
}

export interface ProjectMemoryStore {
  status(): Promise<ProjectMemoryStatus>;
  add(input: ProjectMemoryAddInput): Promise<ProjectMemoryPayload>;
  search(input: ProjectMemorySearchInput): Promise<ProjectMemorySearchHit[]>;
}
