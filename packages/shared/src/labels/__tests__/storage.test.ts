import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getDefaultLabelConfig, loadLabelConfig, saveLabelConfig } from '../storage.ts';
import { findLabelById, flattenLabels } from '../tree.ts';
import type { LabelConfig, WorkspaceLabelConfig } from '../types.ts';

let workspaceRoot: string;

const ROLE_IDS = ['executor', 'auditor', 'designer', 'tester'];

function configPath(): string {
  return join(workspaceRoot, 'labels/config.json');
}

function savedConfig(): WorkspaceLabelConfig {
  return JSON.parse(readFileSync(configPath(), 'utf-8')) as WorkspaceLabelConfig;
}

function ids(labels: LabelConfig[]): string[] {
  return labels.map(label => label.id);
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'labels-storage-test-'));
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('default label storage', () => {
  it('includes role labels under workflow defaults', () => {
    const defaults = getDefaultLabelConfig();
    const workflow = findLabelById(defaults.labels, 'workflow');

    expect(workflow).toBeDefined();
    expect(ids(workflow!.children ?? [])).toEqual([
      'orchestrator',
      'subagent',
      'status',
      'git',
      'worktree',
      'executor',
      'auditor',
      'designer',
      'tester',
    ]);
  });

  it('migrates and persists existing workflow without role labels', () => {
    saveLabelConfig(workspaceRoot, {
      version: 1,
      labels: [
        {
          id: 'workflow',
          name: 'Workflow',
          color: 'success',
          children: [{ id: 'status', name: 'Status', valueType: 'string' }],
        },
      ],
    });

    const loaded = loadLabelConfig(workspaceRoot);
    const workflow = findLabelById(loaded.labels, 'workflow')!;

    expect(workflow.color).toBe('success');
    expect(ids(workflow.children ?? [])).toEqual(['status', ...ROLE_IDS]);
    expect(ids(findLabelById(savedConfig().labels, 'workflow')!.children ?? [])).toEqual(['status', ...ROLE_IDS]);
  });

  it('does not duplicate or move a role label that already exists elsewhere', () => {
    saveLabelConfig(workspaceRoot, {
      version: 1,
      labels: [
        { id: 'executor', name: 'Custom Executor', color: 'accent' },
        { id: 'workflow', name: 'Workflow', children: [] },
      ],
    });

    const loaded = loadLabelConfig(workspaceRoot);
    const flat = flattenLabels(loaded.labels);
    const workflow = findLabelById(loaded.labels, 'workflow')!;

    expect(flat.filter(label => label.id === 'executor')).toHaveLength(1);
    expect(loaded.labels[0]!.id).toBe('executor');
    expect(ids(workflow.children ?? [])).toEqual(['auditor', 'designer', 'tester']);
  });

  it('preserves a user-customized existing executor label', () => {
    const customExecutor = {
      id: 'executor',
      name: 'Executor Team',
      color: { light: '#111111', dark: '#eeeeee' },
      valueType: 'string' as const,
    };
    saveLabelConfig(workspaceRoot, {
      version: 1,
      labels: [
        { id: 'workflow', name: 'Workflow', children: [customExecutor] },
      ],
    });

    const loaded = loadLabelConfig(workspaceRoot);
    const executor = findLabelById(loaded.labels, 'executor')!;

    expect(executor).toEqual(customExecutor);
    expect(ids(findLabelById(loaded.labels, 'workflow')!.children ?? [])).toEqual([
      'executor',
      'auditor',
      'designer',
      'tester',
    ]);
  });

  it('creates a minimal workflow group for missing workflow with partial target role collisions', () => {
    saveLabelConfig(workspaceRoot, {
      version: 1,
      labels: [
        { id: 'executor', name: 'Executor Elsewhere' },
        { id: 'tester', name: 'Tester Elsewhere' },
      ],
    });

    const loaded = loadLabelConfig(workspaceRoot);
    const workflow = findLabelById(loaded.labels, 'workflow')!;
    const flat = flattenLabels(loaded.labels);

    expect(workflow).toBeDefined();
    expect(ids(workflow.children ?? [])).toEqual(['auditor', 'designer']);
    for (const id of ROLE_IDS) {
      expect(flat.filter(label => label.id === id)).toHaveLength(1);
    }
  });

  it('does not create an empty workflow group or save when all target role IDs exist elsewhere', () => {
    saveLabelConfig(workspaceRoot, {
      version: 1,
      labels: ROLE_IDS.map(id => ({ id, name: id })),
    });
    const before = readFileSync(configPath(), 'utf-8');

    const loaded = loadLabelConfig(workspaceRoot);
    const after = readFileSync(configPath(), 'utf-8');

    expect(findLabelById(loaded.labels, 'workflow')).toBeUndefined();
    expect(after).toBe(before);
  });

  it('uses nested non-root workflow as canonical target without creating a root workflow', () => {
    saveLabelConfig(workspaceRoot, {
      version: 1,
      labels: [
        {
          id: 'ops',
          name: 'Ops',
          children: [
            {
              id: 'workflow',
              name: 'Custom Workflow',
              color: 'info',
              children: [{ id: 'release', name: 'Release' }],
            },
          ],
        },
      ],
    });

    const loaded = loadLabelConfig(workspaceRoot);
    const workflow = findLabelById(loaded.labels, 'workflow')!;

    expect(loaded.labels.some(label => label.id === 'workflow')).toBe(false);
    expect(workflow.name).toBe('Custom Workflow');
    expect(workflow.color).toBe('info');
    expect(ids(workflow.children ?? [])).toEqual(['release', ...ROLE_IDS]);
  });

  it('is idempotent on second load after migration', () => {
    saveLabelConfig(workspaceRoot, {
      version: 1,
      labels: [{ id: 'workflow', name: 'Workflow', children: [] }],
    });

    loadLabelConfig(workspaceRoot);
    const afterFirstLoad = readFileSync(configPath(), 'utf-8');
    loadLabelConfig(workspaceRoot);
    const afterSecondLoad = readFileSync(configPath(), 'utf-8');

    expect(afterSecondLoad).toBe(afterFirstLoad);
  });

  it('seeds full defaults when config is missing', () => {
    expect(existsSync(configPath())).toBe(false);

    const loaded = loadLabelConfig(workspaceRoot);
    const workflow = findLabelById(loaded.labels, 'workflow')!;

    expect(existsSync(configPath())).toBe(true);
    expect(ids(workflow.children ?? [])).toEqual([
      'orchestrator',
      'subagent',
      'status',
      'git',
      'worktree',
      'executor',
      'auditor',
      'designer',
      'tester',
    ]);
    expect(findLabelById(loaded.labels, 'development')).toBeDefined();
    expect(findLabelById(loaded.labels, 'content')).toBeDefined();
  });
});
