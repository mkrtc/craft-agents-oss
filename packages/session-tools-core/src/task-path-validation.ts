import { z } from 'zod';

/** Mirrors @craft-agent/shared/tasks SLUG_RE without importing shared task runtime code. */
export const TASK_TOOL_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
export const TASK_TOOL_SLUG_MESSAGE =
  'must be a lowercase task slug (a-z, 0-9, hyphens; no path separators, no "." or "..")';

/** Mirrors @craft-agent/shared/tasks TASK_RUN_ID_RE without importing shared task runtime code. */
export const TASK_TOOL_RUN_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
export const TASK_TOOL_RUN_ID_MESSAGE =
  'must use letters, digits, and hyphens only, with no path separators and no leading or trailing hyphen';

const PATH_SEPARATOR_RE = /[\\/]/;

function isSinglePathComponent(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !PATH_SEPARATOR_RE.test(value)
  );
}

export function isSafeTaskToolSlug(value: unknown): value is string {
  return isSinglePathComponent(value) && TASK_TOOL_SLUG_RE.test(value);
}

export function isSafeTaskToolRunId(value: unknown): value is string {
  return isSinglePathComponent(value) && TASK_TOOL_RUN_ID_RE.test(value);
}

export function taskToolSlugError(fieldName = 'slug'): string {
  return `${fieldName} ${TASK_TOOL_SLUG_MESSAGE}.`;
}

export function taskToolRunIdError(fieldName = 'runId'): string {
  return `${fieldName} ${TASK_TOOL_RUN_ID_MESSAGE}.`;
}

export const TaskToolSlugSchema = z.string().regex(TASK_TOOL_SLUG_RE, TASK_TOOL_SLUG_MESSAGE);
export const TaskToolRunIdSchema = z.string().regex(TASK_TOOL_RUN_ID_RE, TASK_TOOL_RUN_ID_MESSAGE);
