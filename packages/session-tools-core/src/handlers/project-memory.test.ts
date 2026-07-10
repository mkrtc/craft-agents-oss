import { describe, expect, test } from 'bun:test';
import type { SessionToolContext } from '../context.ts';
import { createNodeFileSystem } from '../context.ts';
import { handleProjectMemoryAdd, handleProjectMemorySearch, handleProjectMemoryStatus } from './project-memory.ts';

function makeContext(overrides: Partial<SessionToolContext> = {}): SessionToolContext {
  return {
    sessionId: 'session-1',
    workspacePath: '/tmp/workspace-1',
    plansFolderPath: '/tmp/workspace-1/sessions/session-1/plans',
    dataFolderPath: '/tmp/workspace-1/sessions/session-1/data',
    fs: createNodeFileSystem(),
    getSessionInfo: () => ({
      id: 'session-1',
      name: 'Session 1',
      labels: [],
      status: 'todo',
      permissionMode: 'execute',
      createdAt: 1,
      projectId: 'project-1',
      isActive: true,
    }),
    ...overrides,
  } as SessionToolContext;
}

function text(result: Awaited<ReturnType<typeof handleProjectMemoryStatus>>): string {
  return result.content[0]?.type === 'text' ? result.content[0].text : '';
}

describe('project memory handlers', () => {
  test('adds memory with current workspace and project defaults', async () => {
    let captured: unknown;
    const ctx = makeContext({
      projectMemoryAdd: async (input) => {
        captured = input;
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
      },
    });

    const result = await handleProjectMemoryAdd(ctx, { source: 'decision', content: 'Use Qdrant for MVP.' });
    expect(text(result)).toContain('Project memory added');
    expect(captured).toMatchObject({
      scope: 'project',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      source: 'decision',
    });
  });

  test('searches global workspace and project scopes by default', async () => {
    let captured: unknown;
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
    expect(text(result)).toContain('craft_memory');
    expect(text(result)).toContain('offline');
  });
});
