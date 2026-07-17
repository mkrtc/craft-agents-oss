import { afterEach, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'events';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  DirectoryWatchBroker,
  WatchCapacityError,
  WatchAcquisitionError,
} from '../watch-broker.ts';
import {
  NodeDirectoryWatchAdapter,
  WatchPathError,
  type DirectoryInspectionOptions,
  type DirectoryWatchAdapter,
  type DirectoryWatchEvent,
  type DirectoryWatchHandle,
} from '../watch-adapter.ts';
import type { DirectoryWatchRequest } from '../watch-broker.ts';

class FakeHandle extends EventEmitter implements DirectoryWatchHandle {
  closeCount = 0;
  closed = false;

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCount += 1;
  }

  event(event: DirectoryWatchEvent): void {
    if (!this.closed) this.emit('event', event);
  }
}

class FakeAdapter implements DirectoryWatchAdapter {
  readonly node = new NodeDirectoryWatchAdapter();
  readonly handles = new Map<string, FakeHandle[]>();
  readonly watchCalls = new Map<string, number>();
  readonly failPaths = new Set<string>();
  private listeners = new WeakMap<FakeHandle, (event: DirectoryWatchEvent) => void>();

  inspect(path: string, options?: DirectoryInspectionOptions) {
    return this.node.inspect(path, options);
  }

  watch(path: string, listener: (event: DirectoryWatchEvent) => void): DirectoryWatchHandle {
    const canonical = resolve(path);
    this.watchCalls.set(canonical, (this.watchCalls.get(canonical) ?? 0) + 1);
    if (this.failPaths.has(canonical)) {
      const error = Object.assign(new Error('synthetic ENOSPC'), { code: 'ENOSPC' });
      throw error;
    }
    const handle = new FakeHandle();
    this.listeners.set(handle, listener);
    handle.on('event', listener);
    const handles = this.handles.get(canonical) ?? [];
    handles.push(handle);
    this.handles.set(canonical, handles);
    return handle;
  }

  latest(path: string): FakeHandle {
    const handles = this.handles.get(resolve(path));
    if (!handles?.length) throw new Error(`No handle for ${path}`);
    return handles.at(-1)!;
  }
}

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'watch-broker-'));
  roots.push(root);
  return root;
}

function makeDir(root: string, name: string): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function request(
  path: string,
  priority: DirectoryWatchRequest['priority'],
  overrides: Partial<DirectoryWatchRequest> = {},
): DirectoryWatchRequest {
  return {
    path,
    pathClass: priority === 'required' ? 'workspace-root' : 'session-child',
    priority,
    onEvent: () => {},
    ...overrides,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('DirectoryWatchBroker', () => {
  it('canonicalizes aliases, fans out subscribers, and closes on last release', () => {
    const root = tempRoot();
    const physical = makeDir(root, 'physical');
    const alias = join(root, 'alias');
    symlinkSync(physical, alias, 'dir');
    const adapter = new FakeAdapter();
    const broker = new DirectoryWatchBroker({ adapter, capacity: 4, reconcileIntervalMs: 0 });
    const events: string[] = [];

    const first = broker.acquireOptional(request(physical, 'source', {
      pathClass: 'source-child',
      onEvent: () => events.push('first'),
    }));
    const second = broker.acquireOptional(request(alias, 'skill', {
      pathClass: 'skill-child',
      onEvent: () => events.push('second'),
    }));

    expect(broker.getSnapshot().activeDirectoryCount).toBe(1);
    expect(broker.getSnapshot().leaseCount).toBe(2);
    expect(adapter.watchCalls.get(resolve(physical))).toBe(1);

    adapter.latest(physical).emit('event', { eventType: 'rename', filename: undefined });
    expect(events).toEqual(['first', 'second']);

    first.close();
    expect(adapter.latest(physical).closeCount).toBe(0);
    second.close();
    expect(adapter.latest(physical).closeCount).toBe(1);
    expect(broker.getSnapshot().activeDirectoryCount).toBe(0);
    broker.close();
  });

  it('emits typed content-free diagnostics', () => {
    const root = tempRoot();
    const watched = makeDir(root, 'private-name');
    const adapter = new FakeAdapter();
    const broker = new DirectoryWatchBroker({ adapter, capacity: 1, reconcileIntervalMs: 0 });
    const diagnostics: unknown[] = [];
    const lease = broker.acquireOptional(request(watched, 'source', {
      pathClass: 'source-child',
      onDiagnostic: diagnostic => diagnostics.push(diagnostic),
    }));

    expect(diagnostics.length).toBeGreaterThan(0);
    expect(JSON.stringify(diagnostics)).not.toContain(root);
    expect(diagnostics[0]).toMatchObject({
      pathClass: 'source-child',
      capacity: 1,
      activeDirectoryCount: 1,
    });
    lease.close();
    broker.close();
  });

  it('atomically re-keys a missing placeholder when the directory appears', () => {
    const root = tempRoot();
    const missing = join(root, 'later');
    const adapter = new FakeAdapter();
    const broker = new DirectoryWatchBroker({ adapter, capacity: 1, reconcileIntervalMs: 0 });
    const states: string[] = [];
    const lease = broker.acquireOptional(request(missing, 'session', {
      onStateChange: state => states.push(`${state.status}:${state.reason ?? 'ok'}`),
    }));

    expect(lease.state).toMatchObject({ status: 'degraded', reason: 'missing' });
    expect(broker.getSnapshot().placeholderDirectoryCount).toBe(1);
    expect(broker.getSnapshot().activeDirectoryCount).toBe(0);

    mkdirSync(missing);
    lease.reconcile();
    expect(lease.state.status).toBe('active');
    expect(broker.getSnapshot().placeholderDirectoryCount).toBe(0);
    expect(broker.getSnapshot().activeDirectoryCount).toBe(1);
    expect(states).toContain('active:ok');
    lease.close();
    broker.close();
  });

  it('rejects symlink service children and canonical containment escapes', () => {
    const root = tempRoot();
    const workspace = makeDir(root, 'workspace');
    const outside = makeDir(root, 'outside');
    const link = join(workspace, 'linked-service');
    symlinkSync(outside, link, 'dir');
    const adapter = new NodeDirectoryWatchAdapter();

    expect(() => adapter.inspect(link, { rejectSymlink: true, containWithin: workspace }))
      .toThrow(WatchPathError);
    try {
      adapter.inspect(link, { rejectSymlink: false, containWithin: workspace });
      throw new Error('expected containment failure');
    } catch (error) {
      expect(error).toBeInstanceOf(WatchPathError);
      expect((error as WatchPathError).reason).toBe('outside-root');
    }
  });

  it('evicts optional leases for required controls and recovers by priority', () => {
    const root = tempRoot();
    const session = makeDir(root, 'session');
    const source = makeDir(root, 'source');
    const requiredA = makeDir(root, 'required-a');
    const requiredB = makeDir(root, 'required-b');
    const adapter = new FakeAdapter();
    const broker = new DirectoryWatchBroker({ adapter, capacity: 2, reconcileIntervalMs: 0 });

    const sessionLease = broker.acquireOptional(request(session, 'session'));
    const sourceLease = broker.acquireOptional(request(source, 'source', { pathClass: 'source-child' }));
    expect(broker.getSnapshot().activeDirectoryCount).toBe(2);

    const required = broker.acquireRequired([
      request(requiredA, 'required'),
      request(requiredB, 'required'),
    ]);
    expect(required.every(lease => lease.state.status === 'active')).toBe(true);
    expect(sessionLease.state).toMatchObject({ status: 'degraded', reason: 'capacity' });
    expect(sourceLease.state).toMatchObject({ status: 'degraded', reason: 'capacity' });

    required[0]!.close();
    expect(sourceLease.state.status).toBe('active');
    expect(sessionLease.state.status).toBe('degraded');
    required[1]!.close();
    expect(sessionLease.state.status).toBe('active');

    sourceLease.close();
    sessionLease.close();
    broker.close();
  });

  it('fails a late required transaction when required controls alone exceed the cap', () => {
    const root = tempRoot();
    const firstDir = makeDir(root, 'first');
    const lateDir = makeDir(root, 'late');
    const adapter = new FakeAdapter();
    const broker = new DirectoryWatchBroker({ adapter, capacity: 1, reconcileIntervalMs: 0 });
    const [first] = broker.acquireRequired([request(firstDir, 'required')]);

    expect(() => broker.acquireRequired([request(lateDir, 'required')])).toThrow(WatchCapacityError);
    expect(broker.getSnapshot()).toMatchObject({ activeDirectoryCount: 1, leaseCount: 1 });
    first!.close();
    broker.close();
  });

  it('does not evict optionals when a required transaction cannot possibly fit', () => {
    const root = tempRoot();
    const existingRequired = makeDir(root, 'existing-required');
    const optional = makeDir(root, 'optional');
    const lateA = makeDir(root, 'late-a');
    const lateB = makeDir(root, 'late-b');
    const adapter = new FakeAdapter();
    const broker = new DirectoryWatchBroker({ adapter, capacity: 2, reconcileIntervalMs: 0 });
    const [requiredLease] = broker.acquireRequired([request(existingRequired, 'required')]);
    const optionalLease = broker.acquireOptional(request(optional, 'session'));

    expect(() => broker.acquireRequired([
      request(lateA, 'required'),
      request(lateB, 'required'),
    ])).toThrow(WatchCapacityError);
    expect(optionalLease.state.status).toBe('active');
    expect(broker.getSnapshot()).toMatchObject({ activeDirectoryCount: 2, leaseCount: 2 });

    optionalLease.close();
    requiredLease!.close();
    broker.close();
  });

  it('rolls back a partial required start when fs.watch throws ENOSPC', () => {
    const root = tempRoot();
    const first = makeDir(root, 'first');
    const failing = makeDir(root, 'failing');
    const adapter = new FakeAdapter();
    adapter.failPaths.add(resolve(failing));
    const broker = new DirectoryWatchBroker({ adapter, capacity: 2, reconcileIntervalMs: 0 });

    expect(() => broker.acquireRequired([
      request(first, 'required'),
      request(failing, 'required'),
    ])).toThrow(WatchAcquisitionError);
    expect(broker.getSnapshot()).toMatchObject({ activeDirectoryCount: 0, leaseCount: 0 });
    expect(adapter.latest(first).closeCount).toBe(1);
    broker.close();
  });

  it('quarantines persistent errors without self-retry and allows one unrelated retry', () => {
    const root = tempRoot();
    const failing = makeDir(root, 'failing');
    const unrelated = makeDir(root, 'unrelated');
    const replacement = makeDir(root, 'replacement');
    const adapter = new FakeAdapter();
    const broker = new DirectoryWatchBroker({ adapter, capacity: 2, reconcileIntervalMs: 0 });
    const lease = broker.acquireOptional(request(failing, 'session'));
    const other = broker.acquireOptional(request(unrelated, 'source'));

    adapter.failPaths.add(resolve(failing));
    const asyncError = Object.assign(new Error('async ENOSPC'), { code: 'ENOSPC' });
    adapter.latest(failing).emit('error', asyncError);
    expect(lease.state).toMatchObject({ status: 'degraded', reason: 'watch-error', errorCode: 'ENOSPC' });
    expect(adapter.watchCalls.get(resolve(failing))).toBe(1);

    other.close();
    expect(adapter.watchCalls.get(resolve(failing))).toBe(2);

    const replacementLease = broker.acquireOptional(request(replacement, 'source'));
    replacementLease.close();
    expect(adapter.watchCalls.get(resolve(failing))).toBe(2);

    lease.reconcile();
    expect(adapter.watchCalls.get(resolve(failing))).toBe(3);
    lease.close();
    broker.close();
  });

  it('reattaches after physical directory replacement and ignores stale handles', () => {
    const root = tempRoot();
    const service = makeDir(root, 'service');
    const adapter = new FakeAdapter();
    const broker = new DirectoryWatchBroker({ adapter, capacity: 1, reconcileIntervalMs: 0 });
    let callbacks = 0;
    const lease = broker.acquireOptional(request(service, 'source', { onEvent: () => callbacks++ }));
    const stale = adapter.latest(service);

    rmSync(service, { recursive: true, force: true });
    mkdirSync(service);
    broker.reconcileChanged(10);
    expect(adapter.watchCalls.get(resolve(service))).toBe(2);
    expect(stale.closeCount).toBe(1);

    stale.emit('event', { eventType: 'change', filename: 'stale' });
    expect(callbacks).toBe(0);
    adapter.latest(service).emit('event', { eventType: 'change', filename: 'fresh' });
    expect(callbacks).toBe(1);
    lease.close();
    broker.close();
  });
});
