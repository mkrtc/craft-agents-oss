import type {
  ProjectMemoryAddInput,
  ProjectMemoryKind,
  ProjectMemoryScope,
  ProjectMemorySearchInput,
  SessionToolContext,
} from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse, successResponse } from '../response.ts';

export interface ProjectMemoryAddArgs {
  scope?: ProjectMemoryScope;
  projectId?: string;
  source: ProjectMemoryKind;
  title?: string;
  path?: string;
  taskSlug?: string;
  content: string;
  tags?: string[];
}

export interface ProjectMemorySearchArgs {
  query: string;
  scopes?: ProjectMemoryScope[];
  projectId?: string;
  limit?: number;
  source?: ProjectMemoryKind;
  tags?: string[];
}

export interface ProjectMemoryStatusArgs {}

function currentWorkspaceId(ctx: SessionToolContext): string {
  if (!ctx.workspaceId) {
    throw new Error('workspaceId is required for project memory scoping');
  }
  return ctx.workspaceId;
}

function currentProjectId(ctx: SessionToolContext): string | undefined {
  return ctx.getSessionInfo?.(ctx.sessionId)?.projectId;
}

function assertAuthorizedProjectId(requestedProjectId: string | undefined, sessionProjectId: string | undefined): void {
  if (requestedProjectId === undefined) return;
  if (!sessionProjectId) {
    throw new Error('projectId cannot be provided because the current session is not project-bound');
  }
  if (requestedProjectId !== sessionProjectId) {
    throw new Error('projectId must match the current session project');
  }
}

function resolveCanonicalScope(
  scope: ProjectMemoryScope,
  workspaceId: string,
  sessionProjectId: string | undefined,
): ProjectMemorySearchInput['scopes'][number] {
  if (scope === 'global') return { scope };
  if (scope === 'workspace') return { scope, workspaceId };
  if (!sessionProjectId) {
    throw new Error('Project memory scope "project" is unavailable because the current session is not project-bound');
  }
  return { scope, workspaceId, projectId: sessionProjectId };
}

function resolveAddInput(ctx: SessionToolContext, args: ProjectMemoryAddArgs): ProjectMemoryAddInput {
  const sessionProjectId = currentProjectId(ctx);
  assertAuthorizedProjectId(args.projectId, sessionProjectId);

  // Legacy compatibility: explicit global/workspace adds remain valid, but all
  // location fields are derived from the server-authoritative session context.
  const scope = args.scope ?? (sessionProjectId ? 'project' : 'workspace');
  const canonicalScope = resolveCanonicalScope(scope, currentWorkspaceId(ctx), sessionProjectId);
  return {
    ...canonicalScope,
    source: args.source,
    title: args.title,
    path: args.path,
    sessionId: ctx.sessionId,
    taskSlug: args.taskSlug,
    content: args.content,
    tags: args.tags,
  };
}

function resolveSearchInput(ctx: SessionToolContext, args: ProjectMemorySearchArgs): ProjectMemorySearchInput {
  const sessionProjectId = currentProjectId(ctx);
  assertAuthorizedProjectId(args.projectId, sessionProjectId);

  const workspaceId = currentWorkspaceId(ctx);
  const authorizedScopes: ProjectMemoryScope[] = sessionProjectId
    ? ['global', 'workspace', 'project']
    : ['global', 'workspace'];
  const requestedScopes = args.scopes ?? authorizedScopes;
  const authorizedScopeSet = new Set<ProjectMemoryScope>(authorizedScopes);
  const scopes = requestedScopes
    .filter(scope => authorizedScopeSet.has(scope))
    .map(scope => resolveCanonicalScope(scope, workspaceId, sessionProjectId));
  if (scopes.length === 0) {
    throw new Error('At least one effective project memory scope is required');
  }
  return {
    query: args.query,
    scopes,
    limit: args.limit,
    source: args.source,
    tags: args.tags,
  };
}

export async function handleProjectMemoryAdd(ctx: SessionToolContext, args: ProjectMemoryAddArgs): Promise<ToolResult> {
  if (!ctx.projectMemoryAdd) return errorResponse('project_memory_add is not available in this context.');
  try {
    const input = resolveAddInput(ctx, args);
    const payload = await ctx.projectMemoryAdd(input);
    return successResponse(`Project memory added (${payload.scope}:${payload.id.slice(0, 12)}).`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(`Failed to add project memory: ${message}`);
  }
}

export async function handleProjectMemorySearch(ctx: SessionToolContext, args: ProjectMemorySearchArgs): Promise<ToolResult> {
  if (!ctx.projectMemorySearch) return errorResponse('project_memory_search is not available in this context.');
  try {
    const input = resolveSearchInput(ctx, args);
    const hits = await ctx.projectMemorySearch(input);
    if (hits.length === 0) return successResponse('No project memory matches found.');
    const text = hits.map((hit, index) => {
      const p = hit.payload;
      const title = p.title ? ` — ${p.title}` : '';
      const location = p.path ? `\nPath: ${p.path}` : '';
      const tags = p.tags?.length ? `\nTags: ${p.tags.join(', ')}` : '';
      return `## ${index + 1}. ${p.scope}/${p.source}${title}\nScore: ${hit.score.toFixed(4)}${location}${tags}\n${p.content}`;
    }).join('\n\n');
    return successResponse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(`Failed to search project memory: ${message}`);
  }
}

export async function handleProjectMemoryStatus(ctx: SessionToolContext, _args: ProjectMemoryStatusArgs): Promise<ToolResult> {
  if (!ctx.projectMemoryStatus) return errorResponse('project_memory_status is not available in this context.');
  try {
    const status = await ctx.projectMemoryStatus();
    return successResponse(JSON.stringify(status, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(`Failed to get project memory status: ${message}`);
  }
}
