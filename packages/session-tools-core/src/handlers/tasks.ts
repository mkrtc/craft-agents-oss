import type {
  SessionTaskInvocationContext,
  SessionToolContext,
  TaskCreateInput,
  TaskGetInput,
  TaskGetResultsInput,
  TaskListInput,
  TaskRunInput,
  TaskValidateInput,
} from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse, successResponse } from '../response.ts';
import {
  isSafeTaskToolRunId,
  isSafeTaskToolSlug,
  taskToolRunIdError,
  taskToolSlugError,
} from '../task-path-validation.ts';

export interface TaskValidateArgs extends TaskValidateInput {}
export interface TaskCreateArgs extends TaskCreateInput {}
export interface TaskRunArgs extends TaskRunInput {}
export interface TaskGetArgs extends TaskGetInput {}
export type TaskListArgs = TaskListInput;
export interface TaskGetResultsArgs extends TaskGetResultsInput {}

function taskUnavailable(toolName: string): ToolResult {
  return errorResponse(`${toolName} is not available in this context: task tool callbacks are not configured.`);
}

function invocationContext(ctx: SessionToolContext): SessionTaskInvocationContext {
  return {
    callerSessionId: ctx.sessionId,
    workspacePath: ctx.workspacePath,
    ...(ctx.workingDirectory ? { workingDirectory: ctx.workingDirectory } : {}),
  };
}

function jsonResponse(payload: unknown): ToolResult {
  const text = JSON.stringify(payload ?? null, null, 2);
  const response = successResponse(text);
  response.structuredContent = { result: payload };
  return response;
}

function requiredTaskSlug(value: unknown): string | ToolResult {
  if (!isSafeTaskToolSlug(value)) {
    return errorResponse(taskToolSlugError('slug'));
  }
  return value;
}

function optionalTaskRunId(value: unknown): string | undefined | ToolResult {
  if (value === undefined) return undefined;
  if (!isSafeTaskToolRunId(value)) {
    return errorResponse(taskToolRunIdError('runId'));
  }
  return value;
}

export async function handleTaskValidate(
  ctx: SessionToolContext,
  args: TaskValidateArgs
): Promise<ToolResult> {
  const callback = ctx.taskTools?.validate;
  if (!callback) {
    return taskUnavailable('task_validate');
  }

  if (typeof args.yaml !== 'string') {
    return errorResponse('yaml is required.');
  }

  try {
    const result = await callback({ yaml: args.yaml }, invocationContext(ctx));
    return jsonResponse(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to validate task: ${message}`);
  }
}

export async function handleTaskCreate(
  ctx: SessionToolContext,
  args: TaskCreateArgs
): Promise<ToolResult> {
  const callback = ctx.taskTools?.create;
  if (!callback) {
    return taskUnavailable('task_create');
  }

  if (typeof args.yaml !== 'string' || args.yaml.trim() === '') {
    return errorResponse('yaml is required.');
  }

  try {
    // The current caller session is supplied only through invocationContext(ctx).
    // Do not pass raw orchestratorSessionId / attachToExistingSession through the agent schema.
    const result = await callback({ yaml: args.yaml }, invocationContext(ctx));
    return jsonResponse(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to create task: ${message}`);
  }
}

export async function handleTaskRun(
  ctx: SessionToolContext,
  args: TaskRunArgs
): Promise<ToolResult> {
  const callback = ctx.taskTools?.run;
  if (!callback) {
    return taskUnavailable('task_run');
  }

  const slug = requiredTaskSlug(args.slug);
  if (typeof slug !== 'string') {
    return slug;
  }
  const runId = optionalTaskRunId(args.runId);
  if (runId !== undefined && typeof runId !== 'string') {
    return runId;
  }

  try {
    const input: TaskRunInput = { slug };
    if (runId !== undefined) input.runId = runId;
    if (args.params !== undefined) input.params = args.params;

    // The current caller session is supplied only through invocationContext(ctx) so
    // the backend can default verifier/orchestrator ownership safely.
    const result = await callback(input, invocationContext(ctx));
    return jsonResponse(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to run task: ${message}`);
  }
}

export async function handleTaskGet(
  ctx: SessionToolContext,
  args: TaskGetArgs
): Promise<ToolResult> {
  const callback = ctx.taskTools?.get;
  if (!callback) {
    return taskUnavailable('task_get');
  }

  const slug = requiredTaskSlug(args.slug);
  if (typeof slug !== 'string') {
    return slug;
  }
  const runId = optionalTaskRunId(args.runId);
  if (runId !== undefined && typeof runId !== 'string') {
    return runId;
  }

  try {
    const input: TaskGetInput = { slug };
    if (runId !== undefined) input.runId = runId;
    const result = await callback(input, invocationContext(ctx));
    return jsonResponse(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to get task: ${message}`);
  }
}

export async function handleTaskList(
  ctx: SessionToolContext,
  _args: TaskListArgs = {}
): Promise<ToolResult> {
  const callback = ctx.taskTools?.list;
  if (!callback) {
    return taskUnavailable('task_list');
  }

  try {
    const input: TaskListInput = {};
    const result = await callback(input, invocationContext(ctx));
    return jsonResponse(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to list tasks: ${message}`);
  }
}

export async function handleTaskGetResults(
  ctx: SessionToolContext,
  args: TaskGetResultsArgs
): Promise<ToolResult> {
  const callback = ctx.taskTools?.getResults;
  if (!callback) {
    return taskUnavailable('task_get_results');
  }

  const slug = requiredTaskSlug(args.slug);
  if (typeof slug !== 'string') {
    return slug;
  }
  const runId = optionalTaskRunId(args.runId);
  if (runId !== undefined && typeof runId !== 'string') {
    return runId;
  }

  try {
    const input: TaskGetResultsInput = { slug };
    if (runId !== undefined) input.runId = runId;
    const result = await callback(input, invocationContext(ctx));
    return jsonResponse(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to get task results: ${message}`);
  }
}
