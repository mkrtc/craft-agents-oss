import { describe, expect, it } from 'bun:test';
import type {
  SessionTaskInvocationContext,
  SessionToolContext,
  TaskCreateInput,
  TaskGetInput,
  TaskGetResultsInput,
  TaskRunInput,
  TaskValidateInput,
} from '../context.ts';
import {
  handleTaskCreate,
  handleTaskGet,
  handleTaskGetResults,
  handleTaskList,
  handleTaskRun,
  handleTaskValidate,
} from './tasks.ts';

function createCtx(taskTools?: SessionToolContext['taskTools']): SessionToolContext {
  return {
    sessionId: 'caller-session',
    workspacePath: '/workspace/root',
    workingDirectory: '/workspace/root/project',
    taskTools,
  } as unknown as SessionToolContext;
}

function text(result: { content: Array<{ text: string }> }): string {
  return result.content[0]?.text ?? '';
}

describe('task session tool handlers', () => {
  it('return deterministic unavailable errors when callbacks are missing', async () => {
    const ctx = createCtx();

    const cases = [
      ['task_validate', await handleTaskValidate(ctx, { yaml: 'id: demo' })],
      ['task_create', await handleTaskCreate(ctx, { yaml: 'id: demo' })],
      ['task_run', await handleTaskRun(ctx, { slug: 'demo' })],
      ['task_get', await handleTaskGet(ctx, { slug: 'demo' })],
      ['task_list', await handleTaskList(ctx, {})],
      ['task_get_results', await handleTaskGetResults(ctx, { slug: 'demo' })],
    ] as const;

    for (const [name, result] of cases) {
      expect(result.isError).toBe(true);
      expect(text(result)).toBe(`[ERROR] ${name} is not available in this context: task tool callbacks are not configured.`);
    }
  });

  it('passes current caller session context to task_validate', async () => {
    let seenInput: TaskValidateInput | undefined;
    let seenContext: SessionTaskInvocationContext | undefined;
    const ctx = createCtx({
      validate: (input, invocation) => {
        seenInput = input;
        seenContext = invocation;
        return { valid: true, errors: [], warnings: [], estimate: { nodeCount: 1, sessionNodeCount: 1 } };
      },
    });

    const result = await handleTaskValidate(ctx, { yaml: 'id: demo' });

    expect(result.isError).toBe(false);
    expect(seenInput).toEqual({ yaml: 'id: demo' });
    expect(seenContext).toEqual({
      callerSessionId: 'caller-session',
      workspacePath: '/workspace/root',
      workingDirectory: '/workspace/root/project',
    });
    expect(JSON.parse(text(result))).toEqual({
      valid: true,
      errors: [],
      warnings: [],
      estimate: { nodeCount: 1, sessionNodeCount: 1 },
    });
  });

  it('task_create uses only YAML input and current caller context', async () => {
    let seenInput: TaskCreateInput | undefined;
    let seenContext: SessionTaskInvocationContext | undefined;
    const ctx = createCtx({
      create: (input, invocation) => {
        seenInput = input;
        seenContext = invocation;
        return {
          slug: 'demo',
          orchestratorSessionId: invocation.callerSessionId,
          taskLabelId: 'task-1',
          validation: { valid: true, errors: [], warnings: [] },
        };
      },
    });

    const result = await handleTaskCreate(ctx, {
      yaml: 'id: demo',
      orchestratorSessionId: 'other-session',
      attachToExistingSession: 'other-existing',
    } as unknown as Parameters<typeof handleTaskCreate>[1]);

    expect(result.isError).toBe(false);
    expect(seenInput).toEqual({ yaml: 'id: demo' });
    expect(seenContext?.callerSessionId).toBe('caller-session');
    expect(JSON.parse(text(result))).toMatchObject({
      slug: 'demo',
      orchestratorSessionId: 'caller-session',
      taskLabelId: 'task-1',
    });
  });

  it('task_run omits arbitrary orchestrator passthrough and defaults via caller context', async () => {
    let seenInput: TaskRunInput | undefined;
    let seenContext: SessionTaskInvocationContext | undefined;
    const ctx = createCtx({
      run: (input, invocation) => {
        seenInput = input;
        seenContext = invocation;
        return {
          slug: input.slug,
          runId: input.runId ?? 'run-1',
          taskId: input.slug,
          status: 'running',
          orchestratorSessionId: invocation.callerSessionId,
          nodes: [],
          tokensUsed: 0,
        };
      },
    });

    const result = await handleTaskRun(ctx, {
      slug: 'demo',
      runId: 'run-1',
      params: { answer: 42 },
      orchestratorSessionId: 'other-session',
    } as unknown as Parameters<typeof handleTaskRun>[1]);

    expect(result.isError).toBe(false);
    expect(seenInput).toEqual({ slug: 'demo', runId: 'run-1', params: { answer: 42 } });
    expect(seenContext?.callerSessionId).toBe('caller-session');
    expect(JSON.parse(text(result))).toMatchObject({
      slug: 'demo',
      runId: 'run-1',
      orchestratorSessionId: 'caller-session',
    });
  });

  it('rejects unsafe slugs before invoking task_run/task_get/task_get_results callbacks', async () => {
    let calls = 0;
    const ctx = createCtx({
      run: () => { calls += 1; throw new Error('should not run'); },
      get: () => { calls += 1; throw new Error('should not get'); },
      getResults: () => { calls += 1; throw new Error('should not get results'); },
    });
    const unsafe = ['../x', 'a/../b', '/tmp/x', '..', '.', '', 'a%2Fb', 'a\\b'];

    for (const slug of unsafe) {
      const run = await handleTaskRun(ctx, { slug });
      const get = await handleTaskGet(ctx, { slug });
      const results = await handleTaskGetResults(ctx, { slug });
      expect(run.isError).toBe(true);
      expect(get.isError).toBe(true);
      expect(results.isError).toBe(true);
      expect(text(run)).toContain('slug must be a lowercase task slug');
      expect(text(get)).toContain('slug must be a lowercase task slug');
      expect(text(results)).toContain('slug must be a lowercase task slug');
    }
    expect(calls).toBe(0);
  });

  it('rejects unsafe runIds before invoking task_run/task_get/task_get_results callbacks', async () => {
    let calls = 0;
    const ctx = createCtx({
      run: () => { calls += 1; throw new Error('should not run'); },
      get: () => { calls += 1; throw new Error('should not get'); },
      getResults: () => { calls += 1; throw new Error('should not get results'); },
    });
    const unsafe = ['../x', 'a/../b', '/tmp/x', '..', '.', '', 'a%2Fb', 'a\\b'];

    for (const runId of unsafe) {
      const run = await handleTaskRun(ctx, { slug: 'demo', runId });
      const get = await handleTaskGet(ctx, { slug: 'demo', runId });
      const results = await handleTaskGetResults(ctx, { slug: 'demo', runId });
      expect(run.isError).toBe(true);
      expect(get.isError).toBe(true);
      expect(results.isError).toBe(true);
      expect(text(run)).toContain('runId must use letters, digits, and hyphens only');
      expect(text(get)).toContain('runId must use letters, digits, and hyphens only');
      expect(text(results)).toContain('runId must use letters, digits, and hyphens only');
    }
    expect(calls).toBe(0);
  });

  it('read-only handlers call get/list/getResults callbacks', async () => {
    const calls: Array<{ name: string; input: TaskGetInput | TaskGetResultsInput | Record<string, never> }> = [];
    const ctx = createCtx({
      get: (input) => {
        calls.push({ name: 'get', input });
        return { slug: input.slug, validation: { valid: true, errors: [], warnings: [] }, run: null };
      },
      list: (input) => {
        calls.push({ name: 'list', input });
        return ['demo'];
      },
      getResults: (input) => {
        calls.push({ name: 'getResults', input });
        return { slug: input.slug, runId: input.runId ?? null, runIds: ['run-1'], nodes: [] };
      },
    });

    const get = await handleTaskGet(ctx, { slug: 'demo', runId: 'run-1' });
    const list = await handleTaskList(ctx, {});
    const results = await handleTaskGetResults(ctx, { slug: 'demo', runId: 'run-1' });

    expect(JSON.parse(text(get))).toMatchObject({ slug: 'demo', run: null });
    expect(JSON.parse(text(list))).toEqual(['demo']);
    expect(JSON.parse(text(results))).toMatchObject({ slug: 'demo', runId: 'run-1', runIds: ['run-1'] });
    expect(calls).toEqual([
      { name: 'get', input: { slug: 'demo', runId: 'run-1' } },
      { name: 'list', input: {} },
      { name: 'getResults', input: { slug: 'demo', runId: 'run-1' } },
    ]);
  });

  it('wraps callback failures with deterministic task-specific errors', async () => {
    const ctx = createCtx({
      run: () => {
        throw new Error('runner unavailable');
      },
    });

    const result = await handleTaskRun(ctx, { slug: 'demo' });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe('[ERROR] Failed to run task: runner unavailable');
  });
});
