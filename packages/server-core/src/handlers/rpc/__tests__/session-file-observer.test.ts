import { afterEach, describe, expect, it } from 'bun:test'
import { EventEmitter } from 'events'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import {
  DirectoryWatchBroker,
  NodeDirectoryWatchAdapter,
  type DirectoryInspectionOptions,
  type DirectoryWatchAdapter,
  type DirectoryWatchEvent,
  type DirectoryWatchHandle,
} from '@craft-agent/shared/config'
import {
  SessionFileObserver,
  scanSessionDirectoryBounded,
  type SessionDirectoryScanResult,
} from '../session-file-observer'

class FakeHandle extends EventEmitter implements DirectoryWatchHandle {
  closed = false
  closeCount = 0

  close(): void {
    if (this.closed) return
    this.closed = true
    this.closeCount += 1
  }
}

class FakeAdapter implements DirectoryWatchAdapter {
  private readonly node = new NodeDirectoryWatchAdapter()
  readonly handles = new Map<string, FakeHandle[]>()

  inspect(path: string, options?: DirectoryInspectionOptions) {
    return this.node.inspect(path, options)
  }

  watch(path: string, listener: (event: DirectoryWatchEvent) => void): DirectoryWatchHandle {
    const handle = new FakeHandle()
    handle.on('event', listener)
    const key = resolve(path)
    const handles = this.handles.get(key) ?? []
    handles.push(handle)
    this.handles.set(key, handles)
    return handle
  }
}

const roots: string[] = []
const brokers: DirectoryWatchBroker[] = []

function tempSession(): string {
  const root = mkdtempSync(join(tmpdir(), 'session-file-observer-'))
  roots.push(root)
  return root
}

function broker(adapter: DirectoryWatchAdapter, capacity = 100): DirectoryWatchBroker {
  const instance = new DirectoryWatchBroker({ adapter, capacity, reconcileIntervalMs: 0 })
  brokers.push(instance)
  return instance
}

function wait(ms: number): Promise<void> {
  return new Promise(resolveWait => setTimeout(resolveWait, ms))
}

afterEach(() => {
  for (const instance of brokers.splice(0)) instance.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('scanSessionDirectoryBounded', () => {
  it('enforces entry, depth, and time limits and skips symlinks', async () => {
    const sessionPath = tempSession()
    for (let index = 0; index < 5; index += 1) {
      writeFileSync(join(sessionPath, `file-${index}.txt`), 'x')
    }
    const entryLimited = await scanSessionDirectoryBounded(sessionPath, {
      maxEntries: 3,
      maxDepth: 8,
      maxDurationMs: 1_000,
    })
    expect(entryLimited).toMatchObject({ truncated: true, reason: 'entry-limit' })
    expect(entryLimited.scannedEntries).toBe(4)

    const deep = join(sessionPath, 'a', 'b')
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(deep, 'deep.txt'), 'deep')
    const depthLimited = await scanSessionDirectoryBounded(sessionPath, {
      maxEntries: 100,
      maxDepth: 1,
      maxDurationMs: 1_000,
    })
    expect(depthLimited).toMatchObject({ truncated: true, reason: 'depth-limit' })

    const outside = mkdtempSync(join(tmpdir(), 'session-file-outside-'))
    roots.push(outside)
    symlinkSync(outside, join(sessionPath, 'linked'), 'dir')
    const normal = await scanSessionDirectoryBounded(sessionPath, {
      maxEntries: 100,
      maxDepth: 8,
      maxDurationMs: 1_000,
    })
    expect(normal.files.some(file => file.name === 'linked')).toBe(false)

    const timeLimited = await scanSessionDirectoryBounded(sessionPath, {
      maxEntries: 100,
      maxDepth: 8,
      maxDurationMs: -1,
    })
    expect(timeLimited).toMatchObject({ truncated: true, reason: 'time-limit' })
  })

  it('rejects a symlink session root', async () => {
    const parent = tempSession()
    const physical = join(parent, 'physical')
    const alias = join(parent, 'alias')
    mkdirSync(physical)
    symlinkSync(physical, alias, 'dir')
    const result = await scanSessionDirectoryBounded(alias)
    expect(result).toMatchObject({ truncated: true, reason: 'unsafe-symlink', files: [] })
  })
})

describe('SessionFileObserver', () => {
  it('watches only root/direct children and detects deeper changes by bounded polling', async () => {
    const sessionPath = tempSession()
    const child = join(sessionPath, 'child')
    const deep = join(child, 'deep')
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(deep, 'before.txt'), 'before')
    const adapter = new FakeAdapter()
    const watchBroker = broker(adapter)
    let changes = 0
    const observer = new SessionFileObserver(sessionPath, {
      onChanged: () => changes++,
    }, {
      broker: watchBroker,
      pollIntervalMs: 40,
      changeDebounceMs: 5,
    })

    const status = await observer.start()
    expect(status).toMatchObject({ mode: 'watching', degraded: false, watchedDirectoryCount: 2 })
    expect(adapter.handles.has(resolve(sessionPath))).toBe(true)
    expect(adapter.handles.has(resolve(child))).toBe(true)
    expect(adapter.handles.has(resolve(deep))).toBe(false)

    writeFileSync(join(deep, 'after.txt'), 'after')
    await wait(130)
    expect(changes).toBeGreaterThanOrEqual(1)

    observer.close()
    const atClose = changes
    writeFileSync(join(deep, 'later.txt'), 'later')
    await wait(100)
    expect(changes).toBe(atClose)
    for (const handles of adapter.handles.values()) expect(handles[0]!.closeCount).toBe(1)
  })

  it('coalesces polling to one in-flight scan', async () => {
    const sessionPath = tempSession()
    const adapter = new FakeAdapter()
    const watchBroker = broker(adapter)
    let calls = 0
    let concurrent = 0
    let maxConcurrent = 0
    const scan = async (): Promise<SessionDirectoryScanResult> => {
      calls += 1
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await wait(60)
      concurrent -= 1
      return {
        files: [],
        fingerprint: String(calls),
        scannedEntries: 0,
        scannedDirectories: 1,
        truncated: false,
      }
    }
    const observer = new SessionFileObserver(sessionPath, { onChanged: () => {} }, {
      broker: watchBroker,
      pollIntervalMs: 25,
      scan,
    })

    await observer.start()
    await wait(170)
    observer.close()
    expect(calls).toBeGreaterThanOrEqual(3)
    expect(maxConcurrent).toBe(1)
  })

  it('degrades to polling on descriptor denial and manual refresh on scan limits', async () => {
    const sessionPath = tempSession()
    writeFileSync(join(sessionPath, 'one.txt'), '1')
    writeFileSync(join(sessionPath, 'two.txt'), '2')
    const zeroCapAdapter = new FakeAdapter()
    const zeroCapBroker = broker(zeroCapAdapter, 0)
    const polling = new SessionFileObserver(sessionPath, { onChanged: () => {} }, {
      broker: zeroCapBroker,
      pollIntervalMs: 50,
    })
    expect(await polling.start()).toMatchObject({
      mode: 'polling',
      degraded: true,
      reason: 'capacity',
      watchedDirectoryCount: 0,
    })
    polling.close()

    const adapter = new FakeAdapter()
    const watchBroker = broker(adapter)
    const manual = new SessionFileObserver(sessionPath, { onChanged: () => {} }, {
      broker: watchBroker,
      scanLimits: { maxEntries: 1 },
    })
    expect(await manual.start()).toMatchObject({
      mode: 'manual-refresh',
      degraded: true,
      reason: 'entry-limit',
    })
    rmSync(join(sessionPath, 'two.txt'))
    manual.requestReconcile()
    await wait(30)
    expect(manual.getStatus()).toMatchObject({ mode: 'watching', degraded: false })
    manual.close()
  })

  it('cleans leases and reports removal when the session directory disappears', async () => {
    const sessionPath = tempSession()
    const adapter = new FakeAdapter()
    const watchBroker = broker(adapter)
    let removed = 0
    const observer = new SessionFileObserver(sessionPath, {
      onChanged: () => {},
      onRemoved: () => removed++,
    }, { broker: watchBroker, pollIntervalMs: 50 })
    await observer.start()
    expect(watchBroker.getSnapshot().leaseCount).toBe(1)

    rmSync(sessionPath, { recursive: true, force: true })
    observer.requestReconcile()
    expect(removed).toBe(1)
    expect(watchBroker.getSnapshot()).toMatchObject({ activeDirectoryCount: 0, leaseCount: 0 })
    expect(observer.getStatus()).toMatchObject({ mode: 'manual-refresh', reason: 'path-unavailable' })
  })
})
