import { afterEach, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'events';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { DirectoryWatchBroker } from '../watch-broker.ts';
import {
  NodeDirectoryWatchAdapter,
  type DirectoryInspectionOptions,
  type DirectoryWatchAdapter,
  type DirectoryWatchEvent,
  type DirectoryWatchHandle,
} from '../watch-adapter.ts';
import { calculateConfigWatchBudget } from '../watch-diagnostics.ts';
import { ConfigWatcher } from '../watcher.ts';

class FakeHandle extends EventEmitter implements DirectoryWatchHandle {
  closed = false;
  closeCount = 0;

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCount += 1;
  }
}

class FakeAdapter implements DirectoryWatchAdapter {
  private readonly node = new NodeDirectoryWatchAdapter();
  readonly handles = new Map<string, FakeHandle[]>();

  inspect(path: string, options?: DirectoryInspectionOptions) {
    return this.node.inspect(path, options);
  }

  watch(path: string, listener: (event: DirectoryWatchEvent) => void): DirectoryWatchHandle {
    const handle = new FakeHandle();
    handle.on('event', listener);
    const key = resolve(path);
    const handles = this.handles.get(key) ?? [];
    handles.push(handle);
    this.handles.set(key, handles);
    return handle;
  }

  latest(path: string): FakeHandle {
    const handles = this.handles.get(resolve(path));
    if (!handles?.length) throw new Error(`No watcher for ${path}`);
    return handles.at(-1)!;
  }
}

interface Fixture {
  root: string;
  workspace: string;
  global: string;
  themes: string;
  permissions: string;
}

const roots: string[] = [];
const brokers: DirectoryWatchBroker[] = [];

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'config-watcher-bounded-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const global = join(root, 'global');
  const themes = join(global, 'themes');
  const permissions = join(global, 'permissions');
  for (const path of [workspace, global, themes, permissions]) mkdirSync(path, { recursive: true });
  return { root, workspace, global, themes, permissions };
}

function broker(adapter: DirectoryWatchAdapter, capacity = 100): DirectoryWatchBroker {
  const instance = new DirectoryWatchBroker({ adapter, capacity, reconcileIntervalMs: 0 });
  brokers.push(instance);
  return instance;
}

function watcherFor(
  value: Fixture,
  watchBroker: DirectoryWatchBroker,
  callbacks: ConstructorParameters<typeof ConfigWatcher>[1] = {},
): ConfigWatcher {
  return new ConfigWatcher(value.workspace, callbacks, {
    broker: watchBroker,
    globalConfigDir: value.global,
    appThemesDir: value.themes,
    appPermissionsDir: value.permissions,
  });
}

function waitForDebounce(): Promise<void> {
  return Bun.sleep(160);
}

afterEach(() => {
  for (const instance of brokers.splice(0)) instance.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ConfigWatcher bounded watch matrix', () => {
  it('acquires exactly 3 unique globals + 7 workspace controls + direct children', () => {
    const value = fixture();
    for (const path of [
      join(value.workspace, 'sources', 'source-a'),
      join(value.workspace, 'skills', 'skill-a'),
      join(value.workspace, 'sessions', 'session-a'),
    ]) mkdirSync(path, { recursive: true });
    const adapter = new FakeAdapter();
    const watchBroker = broker(adapter);
    const watcher = watcherFor(value, watchBroker);

    watcher.start();
    const budget = calculateConfigWatchBudget({
      workspaceCount: 1,
      sourceChildDirectories: 1,
      skillChildDirectories: 1,
      sessionChildDirectories: 1,
    });
    expect(budget).toMatchObject({ requiredDirectories: 10, optionalChildren: 3, totalDirectories: 13 });
    expect(watcher.getWatchSnapshot()).toMatchObject({ activeDirectoryCount: 13, leaseCount: 13 });
    expect(adapter.handles.size).toBe(13);

    watcher.stop();
    expect(watchBroker.getSnapshot()).toMatchObject({ activeDirectoryCount: 0, leaseCount: 0 });
    for (const handles of adapter.handles.values()) {
      expect(handles[0]!.closeCount).toBe(1);
    }
  });

  it('adds/removes direct child leases and reads a new session header after its initial write', async () => {
    const value = fixture();
    const adapter = new FakeAdapter();
    const watchBroker = broker(adapter);
    const metadataIds: string[] = [];
    const sourceRemovals: string[] = [];
    const watcher = watcherFor(value, watchBroker, {
      onSessionMetadataChange: (sessionId) => metadataIds.push(sessionId),
      onSourceChange: (slug, source) => { if (!source) sourceRemovals.push(slug); },
    });
    watcher.start();
    expect(watchBroker.getSnapshot().leaseCount).toBe(10);

    const sourceDir = join(value.workspace, 'sources', 'new-source');
    const skillDir = join(value.workspace, 'skills', 'new-skill');
    const sessionDir = join(value.workspace, 'sessions', 'new-session');
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(skillDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: New Skill\ndescription: Test\n---\nBody\n');
    writeFileSync(join(sessionDir, 'session.jsonl'), `${JSON.stringify({
      id: 'new-session',
      workspaceRootPath: value.workspace,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messageCount: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    })}\n`);

    adapter.latest(join(value.workspace, 'sources')).emit('event', { eventType: 'rename', filename: 'new-source' });
    adapter.latest(join(value.workspace, 'skills')).emit('event', { eventType: 'rename', filename: 'new-skill' });
    adapter.latest(join(value.workspace, 'sessions')).emit('event', { eventType: 'rename', filename: 'new-session' });
    await waitForDebounce();

    expect(watchBroker.getSnapshot().leaseCount).toBe(13);
    expect(metadataIds).toEqual(['new-session']);

    watcher.notifyFileChange('sessions/new-session/session.jsonl');
    await waitForDebounce();
    expect(metadataIds).toEqual(['new-session', 'new-session']);

    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
    adapter.latest(join(value.workspace, 'sources')).emit('event', { eventType: 'rename', filename: 'new-source' });
    adapter.latest(join(value.workspace, 'skills')).emit('event', { eventType: 'rename', filename: 'new-skill' });
    adapter.latest(join(value.workspace, 'sessions')).emit('event', { eventType: 'rename', filename: 'new-session' });
    await waitForDebounce();

    expect(watchBroker.getSnapshot().leaseCount).toBe(10);
    expect(sourceRemovals).toEqual(['new-source']);
    watcher.stop();
  });

  it('routes status config/icons and labels, including undefined filenames', async () => {
    const value = fixture();
    const adapter = new FakeAdapter();
    const watchBroker = broker(adapter);
    const callbacks: string[] = [];
    const watcher = watcherFor(value, watchBroker, {
      onStatusConfigChange: () => callbacks.push('status'),
      onStatusIconChange: (_workspaceId, filename) => callbacks.push(`icon:${filename}`),
      onLabelConfigChange: () => callbacks.push('labels'),
    });
    watcher.start();
    writeFileSync(join(value.workspace, 'statuses', 'icons', 'custom.svg'), '<svg/>');

    adapter.latest(join(value.workspace, 'statuses')).emit('event', { eventType: 'change', filename: 'config.json' });
    adapter.latest(join(value.workspace, 'statuses')).emit('event', { eventType: 'rename', filename: 'icons' });
    adapter.latest(join(value.workspace, 'labels')).emit('event', { eventType: 'change', filename: undefined });
    await waitForDebounce();

    expect(callbacks).toContain('status');
    expect(callbacks).toContain('icon:custom.svg');
    expect(callbacks).toContain('labels');
    watcher.stop();
  });

  it('rejects symlink service roots transactionally and symlink direct children diagnostically', () => {
    const value = fixture();
    const outside = join(value.root, 'outside');
    mkdirSync(outside);
    mkdirSync(join(value.workspace, 'sources'), { recursive: true });
    symlinkSync(outside, join(value.workspace, 'sources', 'linked-child'), 'dir');
    const adapter = new FakeAdapter();
    const watchBroker = broker(adapter);
    const reasons: string[] = [];
    const watcher = watcherFor(value, watchBroker, {
      onWatchDiagnostic: diagnostic => { if (diagnostic.reason) reasons.push(diagnostic.reason); },
    });
    watcher.start();
    expect(reasons).toContain('unsafe-symlink');
    expect(watchBroker.getSnapshot().countsByPathClass['source-child'] ?? 0).toBe(0);
    watcher.stop();

    rmSync(join(value.workspace, 'skills'), { recursive: true, force: true });
    symlinkSync(outside, join(value.workspace, 'skills'), 'dir');
    const second = watcherFor(value, watchBroker);
    expect(() => second.start()).toThrow();
    expect(watchBroker.getSnapshot()).toMatchObject({ activeDirectoryCount: 0, leaseCount: 0 });
  });

  it('prioritizes late-workspace controls, shares globals, and fails only beyond required capacity', () => {
    const value = fixture();
    mkdirSync(join(value.workspace, 'sessions', 'optional-session'), { recursive: true });
    const secondWorkspace = join(value.root, 'workspace-two');
    const thirdWorkspace = join(value.root, 'workspace-three');
    mkdirSync(secondWorkspace);
    mkdirSync(thirdWorkspace);
    const adapter = new FakeAdapter();
    const watchBroker = broker(adapter, 17);
    const firstStates: string[] = [];
    const first = watcherFor(value, watchBroker, {
      onWatchStateChange: state => {
        if (state.pathClass === 'session-child') firstStates.push(`${state.status}:${state.reason ?? 'ok'}`);
      },
    });
    const options = {
      broker: watchBroker,
      globalConfigDir: value.global,
      appThemesDir: value.themes,
      appPermissionsDir: value.permissions,
    };
    const second = new ConfigWatcher(secondWorkspace, {}, options);
    const third = new ConfigWatcher(thirdWorkspace, {}, options);

    first.start();
    expect(watchBroker.getSnapshot().activeDirectoryCount).toBe(11);
    second.start();
    expect(watchBroker.getSnapshot()).toMatchObject({ activeDirectoryCount: 17, leaseCount: 21 });
    expect(firstStates).toContain('degraded:capacity');

    expect(() => third.start()).toThrow();
    expect(watchBroker.getSnapshot()).toMatchObject({ activeDirectoryCount: 17, leaseCount: 21 });

    first.stop();
    expect(watchBroker.getSnapshot()).toMatchObject({ activeDirectoryCount: 10, leaseCount: 10 });
    second.stop();
    expect(watchBroker.getSnapshot()).toMatchObject({ activeDirectoryCount: 0, leaseCount: 0 });
  });

  it('performs a bounded catch-up when an evicted session lease recovers', async () => {
    const value = fixture();
    const sessionDir = join(value.workspace, 'sessions', 'recover-session');
    mkdirSync(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, 'session.jsonl');
    const header = {
      id: 'recover-session',
      workspaceRootPath: value.workspace,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messageCount: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    };
    writeFileSync(sessionFile, `${JSON.stringify(header)}\n`);
    const adapter = new FakeAdapter();
    const watchBroker = broker(adapter, 11);
    const metadataIds: string[] = [];
    const watcher = watcherFor(value, watchBroker, {
      onSessionMetadataChange: sessionId => metadataIds.push(sessionId),
    });
    watcher.start();

    const extra = join(value.root, 'extra-required');
    mkdirSync(extra);
    const [extraLease] = watchBroker.acquireRequired([{
      path: extra,
      pathClass: 'workspace-root',
      priority: 'required',
      onEvent: () => {},
    }]);
    writeFileSync(sessionFile, `${JSON.stringify({ ...header, lastUsedAt: Date.now() + 1 })}\n`);
    extraLease!.close();
    await waitForDebounce();

    expect(metadataIds).toEqual(['recover-session']);
    watcher.stop();
  });

  it('is idempotent and drops pending callbacks after stop', async () => {
    const value = fixture();
    const adapter = new FakeAdapter();
    const watchBroker = broker(adapter);
    let callbacks = 0;
    const watcher = watcherFor(value, watchBroker, { onStatusConfigChange: () => callbacks++ });
    watcher.start();
    watcher.start();
    expect(watchBroker.getSnapshot().leaseCount).toBe(10);

    adapter.latest(join(value.workspace, 'statuses')).emit('event', { eventType: 'change', filename: 'config.json' });
    watcher.stop();
    watcher.stop();
    await waitForDebounce();
    expect(callbacks).toBe(0);
    expect(watchBroker.getSnapshot().leaseCount).toBe(0);
  });

  it('keeps descriptor growth constant with 10k irrelevant descendant directories', () => {
    const value = fixture();
    const irrelevantRoot = join(value.workspace, 'unrelated');
    mkdirSync(irrelevantRoot);
    for (let index = 0; index < 10_000; index += 1) {
      mkdirSync(join(irrelevantRoot, `dir-${index}`));
    }
    const adapter = new FakeAdapter();
    const watchBroker = broker(adapter);
    const watcher = watcherFor(value, watchBroker);
    watcher.start();

    expect(watchBroker.getSnapshot()).toMatchObject({ activeDirectoryCount: 10, leaseCount: 10 });
    expect(adapter.handles.has(resolve(irrelevantRoot))).toBe(false);
    watcher.stop();
  });
});
