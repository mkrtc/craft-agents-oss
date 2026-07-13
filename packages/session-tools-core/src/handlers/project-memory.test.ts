import { describe, expect, test } from 'bun:test';
import type {
  ProjectMemoryAddInput,
  ProjectMemoryPayload,
  ProjectMemorySearchInput,
  SessionInfo,
  SessionToolContext,
} from '../context.ts';
import { createNodeFileSystem } from '../context.ts';
import { handleProjectMemoryAdd, handleProjectMemorySearch, handleProjectMemoryStatus } from './project-memory.ts';

function makeSessionInfo(projectId?: string): SessionInfo {
  return {
    id: 'session-1',
    name: 'Session 1',
    labels: [],
    status: 'todo',
    permissionMode: 'execute',
    createdAt: 1,
    ...(projectId ? { projectId } : {}),
    isActive: true,
  };
}

function makeContext(overrides: Partial<SessionToolContext> = {}): SessionToolContext {
  return {
    sessionId: 'session-1',
    workspacePath: '/tmp/workspace-folder-name',
    workspaceId: 'workspace-1',
    plansFolderPath: '/tmp/workspace-1/sessions/session-1/plans',
    dataFolderPath: '/tmp/workspace-1/sessions/session-1/data',
    fs: createNodeFileSystem(),
    getSessionInfo: () => makeSessionInfo('project-1'),
    ...overrides,
  } as SessionToolContext;
}

function addedPayload(input: ProjectMemoryAddInput): ProjectMemoryPayload {
  return {
    id: 'abc123def456',
    scope: input.scope,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    source: input.source,
    content: input.content,
    contentHash: 'hash',
    createdAt: 1,
    updatedAt: 1,
  };
}

function text(result: Awaited<ReturnType<typeof handleProjectMemoryStatus>>): string {
  return result.content[0]?.type === 'text' ? result.content[0].text : '';
}

describe('project memory handlers', () => {
  test('adds memory with current workspace and project defaults', async () => {
    let captured: ProjectMemoryAddInput | undefined;
    const ctx = makeContext({
      projectMemoryAdd: async (input) => {
        captured = input;
        return addedPayload(input);
      },
    });

    const result = await handleProjectMemoryAdd(ctx, { source: 'decision', content: 'Use Qdrant for MVP.' });
    expect(result.isError).toBe(false);
    expect(text(result)).toContain('Project memory added');
    expect(captured).toMatchObject({
      scope: 'project',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      source: 'decision',
    });
  });

  test('preserves explicit global and workspace adds for legacy compatibility while stripping projectId', async () => {
    const captured: ProjectMemoryAddInput[] = [];
    const ctx = makeContext({
      projectMemoryAdd: async (input) => {
        captured.push(input);
        return addedPayload(input);
      },
    });

    const globalResult = await handleProjectMemoryAdd(ctx, {
      scope: 'global',
      projectId: 'project-1',
      source: 'preference',
      content: 'Use concise reports.',
    });
    const workspaceResult = await handleProjectMemoryAdd(ctx, {
      scope: 'workspace',
      projectId: 'project-1',
      source: 'decision',
      content: 'Keep workspace conventions.',
    });

    expect(globalResult.isError).toBe(false);
    expect(workspaceResult.isError).toBe(false);
    expect(captured[0]).toMatchObject({ scope: 'global', source: 'preference' });
    expect(captured[0]).not.toHaveProperty('workspaceId');
    expect(captured[0]).not.toHaveProperty('projectId');
    expect(captured[1]).toMatchObject({
      scope: 'workspace',
      workspaceId: 'workspace-1',
      source: 'decision',
    });
    expect(captured[1]).not.toHaveProperty('projectId');
  });

  test('rejects cross-project writes for every add scope before invoking the store', async () => {
    let calls = 0;
    const ctx = makeContext({
      projectMemoryAdd: async (input) => {
        calls += 1;
        return addedPayload(input);
      },
    });

    for (const scope of ['global', 'workspace', 'project'] as const) {
      const result = await handleProjectMemoryAdd(ctx, {
        scope,
        projectId: 'project-2',
        source: 'decision',
        content: 'Attempt cross-project write.',
      });

      expect(result.isError).toBe(true);
      expect(text(result)).toContain('projectId must match the current session project');
    }
    expect(calls).toBe(0);
  });

  test('defaults unbound adds to the current workspace', async () => {
    let captured: ProjectMemoryAddInput | undefined;
    const ctx = makeContext({
      getSessionInfo: () => makeSessionInfo(),
      projectMemoryAdd: async (input) => {
        captured = input;
        return addedPayload(input);
      },
    });

    const result = await handleProjectMemoryAdd(ctx, {
      source: 'manual-note',
      content: 'Workspace-level note.',
    });

    expect(result.isError).toBe(false);
    expect(captured).toMatchObject({
      scope: 'workspace',
      workspaceId: 'workspace-1',
      source: 'manual-note',
    });
    expect(captured).not.toHaveProperty('projectId');
  });

  test('rejects project adds when the current session is unbound', async () => {
    let calls = 0;
    const ctx = makeContext({
      getSessionInfo: () => makeSessionInfo(),
      projectMemoryAdd: async (input) => {
        calls += 1;
        return addedPayload(input);
      },
    });

    const result = await handleProjectMemoryAdd(ctx, {
      scope: 'project',
      source: 'manual-note',
      content: 'Unavailable project note.',
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('current session is not project-bound');
    expect(calls).toBe(0);
  });

  test('rejects a supplied projectId when the current session is unbound', async () => {
    let calls = 0;
    const ctx = makeContext({
      getSessionInfo: () => makeSessionInfo(),
      projectMemoryAdd: async (input) => {
        calls += 1;
        return addedPayload(input);
      },
    });

    const result = await handleProjectMemoryAdd(ctx, {
      scope: 'workspace',
      projectId: 'project-1',
      source: 'manual-note',
      content: 'Attempt to inject a project binding.',
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('projectId cannot be provided because the current session is not project-bound');
    expect(calls).toBe(0);
  });

  test('searches global workspace and project scopes by default', async () => {
    let captured: ProjectMemorySearchInput | undefined;
    const ctx = makeContext({
      projectMemorySearch: async (input) => {
        captured = input;
        return [{
          score: 0.9,
          payload: {
            id: 'id',
            scope: 'project',
            workspaceId: 'workspace-1',
            projectId: 'project-1',
            source: 'manual-note',
            title: 'Memory note',
            content: 'Relevant memory content',
            contentHash: 'hash',
            createdAt: 1,
            updatedAt: 1,
          },
        }];
      },
    });

    const result = await handleProjectMemorySearch(ctx, { query: 'memory' });
    expect(result.isError).toBe(false);
    expect(text(result)).toContain('Relevant memory content');
    expect(captured).toMatchObject({
      query: 'memory',
      scopes: [
        { scope: 'global' },
        { scope: 'workspace', workspaceId: 'workspace-1' },
        { scope: 'project', workspaceId: 'workspace-1', projectId: 'project-1' },
      ],
    });
  });

  test('accepts an explicit current project and canonicalizes project search scope', async () => {
    let captured: ProjectMemorySearchInput | undefined;
    const ctx = makeContext({
      projectMemorySearch: async (input) => {
        captured = input;
        return [];
      },
    });

    const result = await handleProjectMemorySearch(ctx, {
      query: 'current project',
      scopes: ['project'],
      projectId: 'project-1',
    });

    expect(result.isError).toBe(false);
    expect(captured?.scopes).toEqual([
      { scope: 'project', workspaceId: 'workspace-1', projectId: 'project-1' },
    ]);
  });

  test('allows explicit scopes to narrow a bound search and strips irrelevant projectId', async () => {
    let captured: ProjectMemorySearchInput | undefined;
    const ctx = makeContext({
      projectMemorySearch: async (input) => {
        captured = input;
        return [];
      },
    });

    const result = await handleProjectMemorySearch(ctx, {
      query: 'shared memory',
      scopes: ['global', 'workspace'],
      projectId: 'project-1',
    });

    expect(result.isError).toBe(false);
    expect(captured?.scopes).toEqual([
      { scope: 'global' },
      { scope: 'workspace', workspaceId: 'workspace-1' },
    ]);
  });

  test('rejects cross-project reads before invoking the store', async () => {
    let calls = 0;
    const ctx = makeContext({
      projectMemorySearch: async () => {
        calls += 1;
        return [];
      },
    });

    const result = await handleProjectMemorySearch(ctx, {
      query: 'other project',
      scopes: ['project'],
      projectId: 'project-2',
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('projectId must match the current session project');
    expect(calls).toBe(0);
  });

  test('searches only global and workspace scopes by default when unbound', async () => {
    let captured: ProjectMemorySearchInput | undefined;
    const ctx = makeContext({
      getSessionInfo: () => makeSessionInfo(),
      projectMemorySearch: async (input) => {
        captured = input;
        return [];
      },
    });

    const result = await handleProjectMemorySearch(ctx, { query: 'memory' });

    expect(result.isError).toBe(false);
    expect(captured?.scopes).toEqual([
      { scope: 'global' },
      { scope: 'workspace', workspaceId: 'workspace-1' },
    ]);
  });

  test('safely drops unavailable project scope when an authorized scope remains', async () => {
    let captured: ProjectMemorySearchInput | undefined;
    const ctx = makeContext({
      getSessionInfo: () => makeSessionInfo(),
      projectMemorySearch: async (input) => {
        captured = input;
        return [];
      },
    });

    const result = await handleProjectMemorySearch(ctx, {
      query: 'memory',
      scopes: ['project', 'workspace'],
    });

    expect(result.isError).toBe(false);
    expect(captured?.scopes).toEqual([
      { scope: 'workspace', workspaceId: 'workspace-1' },
    ]);
  });

  test('rejects empty effective search scopes instead of searching unscoped', async () => {
    let calls = 0;
    const ctx = makeContext({
      getSessionInfo: () => makeSessionInfo(),
      projectMemorySearch: async () => {
        calls += 1;
        return [];
      },
    });

    const result = await handleProjectMemorySearch(ctx, { query: 'memory', scopes: ['project'] });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('At least one effective project memory scope is required');
    expect(calls).toBe(0);
  });

  test('requires canonical workspaceId for scoped memory', async () => {
    const ctx = makeContext({
      workspaceId: undefined,
      projectMemorySearch: async () => [],
    });

    const result = await handleProjectMemorySearch(ctx, { query: 'memory' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('workspaceId is required for project memory scoping');
  });

  test('reports backend status', async () => {
    const ctx = makeContext({
      projectMemoryStatus: async () => ({
        enabled: true,
        provider: 'qdrant',
        url: 'http://127.0.0.1:6333',
        collection: 'craft_memory',
        dimension: 384,
        ok: false,
        error: 'offline',
      }),
    });

    const result = await handleProjectMemoryStatus(ctx, {});
    expect(result.isError).toBe(false);
    expect(text(result)).toContain('craft_memory');
    expect(text(result)).toContain('offline');
  });
});
