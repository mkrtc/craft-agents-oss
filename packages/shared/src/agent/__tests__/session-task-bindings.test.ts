import { describe, expect, it, beforeEach } from 'bun:test';
import type { SessionToolContext } from '@craft-agent/session-tools-core';
import { createClaudeContext } from '../claude-context.ts';
import { attachSessionTaskToolBindings } from '../session-task-bindings.ts';
import {
  mergeSessionScopedToolCallbacks,
  registerSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
} from '../session-scoped-tools.ts';

const noopPlan = () => {};
const noopAuth = () => {};

function createBaseContext(sessionId: string): SessionToolContext {
  return createClaudeContext({
    sessionId,
    workspacePath: '/tmp/test-workspace',
    workspaceId: 'test-workspace',
    onPlanSubmitted: noopPlan,
    onAuthRequest: noopAuth,
  });
}

describe('attachSessionTaskToolBindings', () => {
  const sessionId = 'test-task-bindings';

  beforeEach(() => {
    unregisterSessionScopedToolCallbacks(sessionId);
  });

  it('keeps taskTools undefined when callbacks are absent', () => {
    const ctx = createBaseContext(sessionId);
    attachSessionTaskToolBindings(ctx, sessionId);

    expect(ctx.taskTools).toBeUndefined();
  });

  it('resolves task callbacks from the registry lazily', async () => {
    const ctx = createBaseContext(sessionId);
    attachSessionTaskToolBindings(ctx, sessionId);

    registerSessionScopedToolCallbacks(sessionId, {
      taskTools: {
        list: () => ['first'],
      },
    });

    expect(await ctx.taskTools?.list?.({}, {
      callerSessionId: sessionId,
      workspacePath: '/tmp/test-workspace',
    })).toEqual(['first']);

    mergeSessionScopedToolCallbacks(sessionId, {
      taskTools: {
        list: () => ['second'],
      },
    });

    expect(await ctx.taskTools?.list?.({}, {
      callerSessionId: sessionId,
      workspacePath: '/tmp/test-workspace',
    })).toEqual(['second']);
  });
});
