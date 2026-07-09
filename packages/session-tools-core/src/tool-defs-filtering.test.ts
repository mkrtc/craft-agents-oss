import { describe, it, expect } from 'bun:test';
import {
  SESSION_TOOL_DEFS,
  getSessionToolDefs,
  getSessionToolNames,
  getSessionToolRegistry,
  getSessionSafeAllowedToolNames,
  getSessionSafeBlockedToolNames,
  getToolDefsAsJsonSchema,
  TaskGetResultsSchema,
  TaskGetSchema,
  TaskRunSchema,
} from './tool-defs.ts';

describe('session tool filtering helpers', () => {
  it('excludes developer feedback tool when includeDeveloperFeedback is false', () => {
    const defs = getSessionToolDefs({ includeDeveloperFeedback: false });
    const names = defs.map(d => d.name);

    expect(names.includes('send_developer_feedback')).toBe(false);
  });

  it('includes developer feedback tool when includeDeveloperFeedback is true', () => {
    const defs = getSessionToolDefs({ includeDeveloperFeedback: true });
    const names = defs.map(d => d.name);

    expect(names.includes('send_developer_feedback')).toBe(true);
  });

  it('name set and registry stay aligned for filtered output', () => {
    const names = getSessionToolNames({ includeDeveloperFeedback: false });
    const registry = getSessionToolRegistry({ includeDeveloperFeedback: false });

    expect(registry.has('send_developer_feedback')).toBe(false);
    expect(names.has('send_developer_feedback')).toBe(false);

    for (const name of names) {
      expect(registry.has(name)).toBe(true);
    }
  });

  it('json schema conversion respects includeDeveloperFeedback filter', () => {
    const defs = getToolDefsAsJsonSchema({ includeDeveloperFeedback: false });
    const names = defs.map(d => d.name);

    expect(names.includes('send_developer_feedback')).toBe(false);
  });

  it('all canonical session tools declare safeMode metadata', () => {
    for (const def of SESSION_TOOL_DEFS) {
      expect(def.safeMode === 'allow' || def.safeMode === 'block').toBe(true);
    }
  });

  it('safe-mode helper sets classify expected tools', () => {
    const allowed = getSessionSafeAllowedToolNames();
    const blocked = getSessionSafeBlockedToolNames();

    expect(allowed.has('send_developer_feedback')).toBe(true);
    expect(allowed.has('call_llm')).toBe(true);
    expect(allowed.has('browser_tool')).toBe(true);
    expect(allowed.has('script_sandbox')).toBe(true);
    expect(allowed.has('task_validate')).toBe(true);
    expect(allowed.has('task_get')).toBe(true);
    expect(allowed.has('task_list')).toBe(true);
    expect(allowed.has('task_get_results')).toBe(true);

    expect(blocked.has('source_oauth_trigger')).toBe(true);
    expect(blocked.has('source_credential_prompt')).toBe(true);
    expect(blocked.has('spawn_session')).toBe(true);
    expect(blocked.has('task_create')).toBe(true);
    expect(blocked.has('task_run')).toBe(true);
  });

  it('task tool input schemas reject unsafe slug and runId path components', () => {
    const unsafe = ['../x', 'a/../b', '/tmp/x', '..', '.', '', 'a%2Fb', 'a\\b'];

    for (const value of unsafe) {
      expect(TaskRunSchema.safeParse({ slug: value }).success).toBe(false);
      expect(TaskGetSchema.safeParse({ slug: value }).success).toBe(false);
      expect(TaskGetResultsSchema.safeParse({ slug: value }).success).toBe(false);
      expect(TaskRunSchema.safeParse({ slug: 'demo', runId: value }).success).toBe(false);
      expect(TaskGetSchema.safeParse({ slug: 'demo', runId: value }).success).toBe(false);
      expect(TaskGetResultsSchema.safeParse({ slug: 'demo', runId: value }).success).toBe(false);
    }

    expect(TaskRunSchema.safeParse({ slug: 'demo-task', runId: 'run-20260709' }).success).toBe(true);
    expect(TaskGetSchema.safeParse({ slug: 'demo-task', runId: '550e8400-e29b-41d4-a716-446655440000' }).success).toBe(true);
    expect(TaskGetResultsSchema.safeParse({ slug: 'demo-task' }).success).toBe(true);
  });

  it('task tool registry metadata matches MVP safety contract', () => {
    const defsByName = new Map(SESSION_TOOL_DEFS.map(def => [def.name, def]));
    const readOnlyAllowed = ['task_validate', 'task_get', 'task_list', 'task_get_results'];
    const sideEffectingBlocked = ['task_create', 'task_run'];

    for (const name of readOnlyAllowed) {
      const def = defsByName.get(name);
      expect(def).toBeDefined();
      expect(def?.executionMode).toBe('registry');
      expect(def?.safeMode).toBe('allow');
      expect(def?.readOnly).toBe(true);
    }

    for (const name of sideEffectingBlocked) {
      const def = defsByName.get(name);
      expect(def).toBeDefined();
      expect(def?.executionMode).toBe('registry');
      expect(def?.safeMode).toBe('block');
      expect(def?.readOnly).toBeUndefined();
      expect(def?.description.toLowerCase()).toContain('side effects');
    }

    expect(defsByName.has('task_generate')).toBe(false);
  });

  it('safe-mode helpers support MCP prefixing', () => {
    const allowedPrefixed = getSessionSafeAllowedToolNames({ prefix: 'mcp__session__' });
    const blockedPrefixed = getSessionSafeBlockedToolNames({ prefix: 'mcp__session__' });

    expect(allowedPrefixed.has('mcp__session__send_developer_feedback')).toBe(true);
    expect(allowedPrefixed.has('mcp__session__call_llm')).toBe(true);
    expect(allowedPrefixed.has('mcp__session__script_sandbox')).toBe(true);
    expect(allowedPrefixed.has('mcp__session__task_validate')).toBe(true);
    expect(allowedPrefixed.has('mcp__session__task_get_results')).toBe(true);
    expect(blockedPrefixed.has('mcp__session__source_oauth_trigger')).toBe(true);
    expect(blockedPrefixed.has('mcp__session__spawn_session')).toBe(true);
    expect(blockedPrefixed.has('mcp__session__task_create')).toBe(true);
    expect(blockedPrefixed.has('mcp__session__task_run')).toBe(true);
  });
});
