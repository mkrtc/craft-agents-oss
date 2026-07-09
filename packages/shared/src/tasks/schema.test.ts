import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  assertSafeTaskPathComponent,
  assertTaskNodeOutputId,
  assertTaskRunId,
  assertTaskSlug,
  isSafeTaskPathComponent,
  isTaskNodeOutputId,
  isTaskRunId,
  isTaskSlug,
  parseTaskSpec,
  nodeDeps,
  nodeTitle,
  type TaskSpec,
} from './schema.ts';
import { extractRefs, interpolateRefs } from './refs.ts';
import { validateTaskSpec, validateTaskInput, TASK_CAPS } from './validate.ts';
import { buildGeneratorPrompt, buildRepairPrompt } from './generator-prompt.ts';
import {
  parseTaskYaml,
  serializeTaskYaml,
  saveTaskSpec,
  loadTaskSpec,
  appendRunLog,
  readRunLog,
  writeNodeOutput,
  readNodeOutput,
  listTaskSlugs,
  taskDir,
  runDir,
  type RunLogEntry,
} from './storage.ts';

/** A valid 3-node chain: audit → design → impl (the V1 acceptance shape). */
const CHAIN = {
  id: 'demo',
  title: 'Demo chain',
  goal: 'audit then design then implement',
  nodes: [
    { id: 'audit', prompt: 'Audit the code' },
    { id: 'design', depends_on: ['audit'], prompt: 'Design using ${nodes.audit.output}' },
    { id: 'impl', depends_on: ['design'], prompt: 'Implement ${nodes.design.output}' },
  ],
  outputs: { result: '${nodes.impl.output}' },
};

function parsed(): TaskSpec {
  const r = parseTaskSpec(CHAIN);
  if (!r.success) throw new Error('fixture should parse');
  return r.data;
}

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

describe('schema', () => {
  it('parses a valid chain and applies defaults', () => {
    const r = parseTaskSpec(CHAIN);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.runner).toBe('conduct');
    expect(r.data.nodes[0]!.kind).toBe('session');
    expect(nodeDeps(r.data.nodes[1]!)).toEqual(['audit']);
    expect(nodeTitle(r.data.nodes[0]!)).toBe('audit'); // title falls back to id
  });

  it('normalizes the legacy `type` alias onto `kind`', () => {
    const r = parseTaskSpec({
      id: 'x',
      title: 'X',
      goal: 'g',
      nodes: [{ id: 'dyn', type: 'orchestrator', prompt: 'expand' }],
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.nodes[0]!.kind).toBe('orchestrator');
    expect((r.data.nodes[0] as Record<string, unknown>).type).toBeUndefined();
  });

  it('requires a prompt on session nodes', () => {
    const r = parseTaskSpec({ id: 'x', title: 'X', goal: 'g', nodes: [{ id: 'a' }] });
    expect(r.success).toBe(false);
  });

  it('accepts an optional acceptance_criteria rubric', () => {
    const r = parseTaskSpec({ ...CHAIN, acceptance_criteria: 'The implementation must pass all tests.' });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.acceptance_criteria).toBe('The implementation must pass all tests.');
  });

  it('accepts max_iterations at the cap and at zero, rejects above the cap', () => {
    expect(parseTaskSpec({ ...CHAIN, max_iterations: 10 }).success).toBe(true);
    expect(parseTaskSpec({ ...CHAIN, max_iterations: 0 }).success).toBe(true);
    expect(parseTaskSpec({ ...CHAIN, max_iterations: 11 }).success).toBe(false);
  });

  it('accepts optional task-level and node-level skills with safe slugs', () => {
    const r = parseTaskSpec({
      ...CHAIN,
      sources: ['github', 'linear'],
      skills: ['backend-developer'],
      nodes: [{ id: 'audit', prompt: 'Audit the code', skills: ['security-review'] }],
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.sources).toEqual(['github', 'linear']);
    expect(r.data.skills).toEqual(['backend-developer']);
    expect(r.data.nodes[0]!.skills).toEqual(['security-review']);
    expect(parseTaskSpec({ ...CHAIN, sources: [''] }).success).toBe(false);
  });

  it('rejects unsafe task-level and node-level skill values', () => {
    const badSkills = ['Backend', 'bad slug', 'bad-', 'good] [skill:evil', 'multi\nline'];
    for (const skill of badSkills) {
      expect(parseTaskSpec({ ...CHAIN, skills: [skill] }).success).toBe(false);
      expect(parseTaskSpec({ ...CHAIN, nodes: [{ id: 'audit', prompt: 'Audit', skills: [skill] }] }).success).toBe(false);
    }
  });

  it('rejects duplicate node ids', () => {
    const r = parseTaskSpec({
      id: 'x',
      title: 'X',
      goal: 'g',
      nodes: [
        { id: 'a', prompt: 'p' },
        { id: 'a', prompt: 'q' },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('rejects an invalid slug id', () => {
    const r = parseTaskSpec({ id: 'Bad Id', title: 'X', goal: 'g', nodes: [{ id: 'a', prompt: 'p' }] });
    expect(r.success).toBe(false);
  });

  it('validates safe task storage path components without normalizing traversal', () => {
    expect(assertSafeTaskPathComponent('component')).toBe('component');
    expect(assertTaskSlug('demo-task')).toBe('demo-task');
    expect(assertTaskRunId('run-20260709')).toBe('run-20260709');
    expect(assertTaskRunId('550e8400-e29b-41d4-a716-446655440000')).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(assertTaskNodeOutputId('audit')).toBe('audit');
    expect(assertTaskNodeOutputId('__verdict__')).toBe('__verdict__');

    const unsafe = ['../x', 'a/../b', '/tmp/x', '..', '.', '', 'a%2Fb', 'a\\b'];
    for (const value of unsafe) {
      expect(isSafeTaskPathComponent(value)).toBe(false);
      expect(isTaskSlug(value)).toBe(false);
      expect(isTaskRunId(value)).toBe(false);
      expect(isTaskNodeOutputId(value)).toBe(false);
      expect(() => assertSafeTaskPathComponent(value)).toThrow(/Invalid task path component/);
      expect(() => assertTaskSlug(value)).toThrow(/Invalid task slug/);
      expect(() => assertTaskRunId(value)).toThrow(/Invalid task run ID/);
      expect(() => assertTaskNodeOutputId(value)).toThrow(/Invalid task node output id/);
    }
  });
});

// ---------------------------------------------------------------------------
// refs
// ---------------------------------------------------------------------------

describe('refs', () => {
  it('extracts node, field, and param references', () => {
    const refs = extractRefs('use ${nodes.audit.output} and ${nodes.design.output.score} with ${params.env}');
    expect(refs).toHaveLength(3);
    expect(refs[0]).toMatchObject({ kind: 'node', nodeId: 'audit' });
    expect(refs[1]).toMatchObject({ kind: 'node', nodeId: 'design', field: 'score' });
    expect(refs[2]).toMatchObject({ kind: 'param', name: 'env' });
  });

  it('interpolates text, fields, and params; leaves unknown refs raw', () => {
    const out = interpolateRefs(
      'A=${nodes.a.output} B=${nodes.a.output.score} P=${params.env} M=${nodes.missing.output}',
      { nodeOutputs: { a: { text: 'hello', params: { score: 7 } } }, params: { env: 'prod' } },
    );
    expect(out).toBe('A=hello B=7 P=prod M=${nodes.missing.output}');
  });

  it('supports an onMissing fallback', () => {
    const out = interpolateRefs('X=${nodes.ghost.output}', { nodeOutputs: {} }, { onMissing: () => '<none>' });
    expect(out).toBe('X=<none>');
  });
});

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

describe('validate', () => {
  it('accepts a valid chain with no errors or warnings', () => {
    const res = validateTaskSpec(parsed());
    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
    expect(res.warnings).toHaveLength(0);
  });

  it('flags dangling depends_on', () => {
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [{ id: 'a', prompt: 'p', depends_on: ['ghost'] }],
    });
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.message.includes('unknown node "ghost"'))).toBe(true);
  });

  it('flags an unresolved node reference', () => {
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [{ id: 'a', prompt: 'see ${nodes.ghost.output}' }],
    });
    expect(res.errors.some((e) => e.message.includes('unknown node "ghost"'))).toBe(true);
  });

  it('warns when a referenced node is not listed in depends_on', () => {
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [
        { id: 'a', prompt: 'p' },
        { id: 'b', prompt: 'uses ${nodes.a.output}' }, // no depends_on
      ],
    });
    expect(res.valid).toBe(true);
    expect(res.warnings.some((w) => w.message.includes('does not list it in depends_on'))).toBe(true);
  });

  it('errors on an undeclared param reference but accepts a declared one', () => {
    const bad = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [{ id: 'a', prompt: 'env is ${params.env}' }],
    });
    expect(bad.errors.some((e) => e.message.includes('undeclared task param "env"'))).toBe(true);

    const ok = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      params: [{ name: 'env' }],
      nodes: [{ id: 'a', prompt: 'env is ${params.env}' }],
    });
    expect(ok.errors).toHaveLength(0);
  });

  it('warns when a reference reads a structured output field (not populated in v1)', () => {
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [
        { id: 'a', prompt: 'p' },
        { id: 'b', depends_on: ['a'], prompt: 'uses ${nodes.a.output.score}' },
      ],
    });
    expect(res.valid).toBe(true);
    expect(res.warnings.some((w) => w.message.includes('structured output field'))).toBe(true);
  });

  it('detects a dependency cycle', () => {
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [
        { id: 'a', prompt: 'p', depends_on: ['b'] },
        { id: 'b', prompt: 'q', depends_on: ['a'] },
      ],
    });
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.message.includes('cycle'))).toBe(true);
  });

  it('rejects a self-dependency', () => {
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [{ id: 'a', prompt: 'p', depends_on: ['a'] }],
    });
    expect(res.errors.some((e) => e.message.includes('depends on itself'))).toBe(true);
  });

  it('errors when loop.max exceeds the cap', () => {
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [{ id: 'a', prompt: 'p', loop: { until: 'DONE', max: TASK_CAPS.maxLoopIterations + 1 } }],
    });
    expect(res.errors.some((e) => e.message.includes('exceeds the cap'))).toBe(true);
  });

  it('warns on an unknown model', () => {
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [{ id: 'a', prompt: 'p', model: 'gpt-imaginary-9' }],
    });
    expect(res.warnings.some((w) => w.message.includes('not a known built-in model'))).toBe(true);
  });

  it('errors when the node count exceeds the cap', () => {
    const nodes = Array.from({ length: TASK_CAPS.maxNodes + 1 }, (_, i) => ({ id: `n${i}`, prompt: 'p' }));
    const res = validateTaskInput({ id: 'x', title: 'X', goal: 'g', nodes });
    expect(res.errors.some((e) => e.message.includes('exceeding the cap'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

describe('storage', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tasks-test-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('round-trips a spec through task.yaml', () => {
    const spec = parsed();
    saveTaskSpec(root, spec);

    expect(listTaskSlugs(root)).toEqual(['demo']);

    const loaded = loadTaskSpec(root, 'demo');
    expect(loaded?.valid).toBe(true);
    expect(loaded?.spec?.id).toBe('demo');
    expect(loaded?.spec?.nodes.map((n) => n.id)).toEqual(['audit', 'design', 'impl']);
    expect(nodeDeps(loaded!.spec!.nodes[1]!)).toEqual(['audit']);
  });

  it('serializes node skills to parseable yaml', () => {
    const spec = parsed();
    spec.skills = ['backend-developer'];
    spec.nodes[0]!.skills = ['security-review'];
    const yaml = serializeTaskYaml(spec);
    const reparsed = parseTaskYaml(yaml);
    expect(reparsed.valid).toBe(true);
    expect(reparsed.spec?.title).toBe('Demo chain');
    expect(reparsed.spec?.skills).toEqual(['backend-developer']);
    expect(reparsed.spec?.nodes[0]?.skills).toEqual(['security-review']);
  });

  it('reports invalid yaml without throwing', () => {
    const res = parseTaskYaml(':\n  - [unbalanced');
    expect(res.valid).toBe(false);
    expect(res.errors[0]?.message).toContain('Invalid YAML');
  });

  it('appends and reads the run log in order', () => {
    const entries: RunLogEntry[] = [
      { t: '2026-06-07T00:00:00.000Z', kind: 'run-started', taskId: 'demo', runId: 'r1' },
      { t: '2026-06-07T00:00:01.000Z', kind: 'node-scheduled', nodeId: 'audit' },
      { t: '2026-06-07T00:00:02.000Z', kind: 'node-spawned', nodeId: 'audit', sessionId: 's-audit' },
      { t: '2026-06-07T00:00:03.000Z', kind: 'node-finished', nodeId: 'audit', sessionId: 's-audit', state: 'done' },
    ];
    for (const e of entries) appendRunLog(root, 'demo', 'r1', e);
    expect(readRunLog(root, 'demo', 'r1')).toEqual(entries);
  });

  it('writes and reads per-node output', () => {
    writeNodeOutput(root, 'demo', 'r1', 'audit', { text: 'findings', params: { count: 3 } });
    expect(readNodeOutput(root, 'demo', 'r1', 'audit')).toEqual({ text: 'findings', params: { count: 3 } });
    expect(readNodeOutput(root, 'demo', 'r1', 'missing')).toBeNull();
  });

  it('rejects unsafe task storage path components before joining paths', () => {
    const unsafe = ['../x', 'a/../b', '/tmp/x', '..', '.', '', 'a%2Fb', 'a\\b'];
    for (const value of unsafe) {
      expect(() => taskDir(root, value)).toThrow(/Invalid task slug/);
      expect(() => runDir(root, 'demo', value)).toThrow(/Invalid task run ID/);
      expect(() => loadTaskSpec(root, value)).toThrow(/Invalid task slug/);
      expect(() => appendRunLog(root, 'demo', value, { t: '2026-06-07T00:00:00.000Z', kind: 'run-started', taskId: 'demo', runId: 'r1' })).toThrow(/Invalid task run ID/);
      expect(() => writeNodeOutput(root, 'demo', 'r1', value, { text: 'bad' })).toThrow(/Invalid task node output id/);
      expect(() => readNodeOutput(root, 'demo', 'r1', value)).toThrow(/Invalid task node output id/);
    }
  });
});

describe('generator-prompt', () => {
  it('instructs the model that every reference must resolve to a declared node', () => {
    const prompt = buildGeneratorPrompt('Decompose the goal', 'My task');
    expect(prompt).toContain('${nodes.<id>.output} reference MUST point to an `id` that you actually declare');
    expect(prompt).toContain('Goal: Decompose the goal');
    expect(prompt).toContain('Working title: My task');
    expect(prompt).toContain('Optional `skills` arrays may appear at the task level or on individual nodes');
    expect(prompt).toContain('Do not tell child workers to set their own session to closed statuses');
  });

  it('guides dynamic model and connection selection without hardcoded concrete recommendations', () => {
    const prompt = buildGeneratorPrompt('Decompose the goal');
    expect(prompt).toContain('Use reliable available model and connection metadata from the Craft tool surface when provided');
    expect(prompt).toContain('defaults.model');
    expect(prompt).toContain('defaults.llmConnection');
    expect(prompt).toContain('node.model');
    expect(prompt).toContain('node.llmConnection');
    expect(prompt).toContain('omit `model` and `llmConnection` fields and use runtime defaults');
    expect(prompt).toContain('Artificial Analysis Coding Agent Index (https://artificialanalysis.ai/agents/coding-agents)');
    expect(prompt).toContain('optional references, not hard dependencies');
    expect(prompt).toContain('fastest/cheapest sufficiently capable');
    expect(prompt).toContain('strongest/specialized available option');
    expect(prompt).toContain('matching connection');

    const lowerPrompt = prompt.toLowerCase();
    for (const forbidden of ['gpt-', 'claude-', 'gemini', 'codex', 'sonnet', 'opus', 'haiku', 'fable']) {
      expect(lowerPrompt).not.toContain(forbidden);
    }
  });

  it('repair prompt lists each validation error and re-asserts the YAML-only contract', () => {
    const prompt = buildRepairPrompt([
      { path: 'nodes.design.inputs', message: 'Reference ${nodes.audit-completion-signal.output} points to unknown node "audit-completion-signal"' },
      { path: 'root', message: 'second problem' },
    ]);
    expect(prompt).toContain('- nodes.design.inputs: Reference ${nodes.audit-completion-signal.output} points to unknown node "audit-completion-signal"');
    expect(prompt).toContain('- root: second problem');
    expect(prompt).toContain('Output ONLY the YAML');
  });
});
