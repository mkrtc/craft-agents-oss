import {
  lstatSync,
  opendirSync,
  realpathSync,
  type Dirent,
} from 'fs'
import {
  lstat,
  readdir,
  realpath,
} from 'fs/promises'
import { dirname, isAbsolute, join, relative } from 'path'
import type {
  SessionFile,
  SessionFileWatchDegradedReason,
  SessionFileWatchStatus,
} from '@craft-agent/shared/protocol'
import {
  getProcessWatchBroker,
  type DirectoryWatchBroker,
  type DirectoryWatchLease,
  type WatchLeaseState,
} from '@craft-agent/shared/config'

export interface SessionDirectoryScanLimits {
  maxEntries: number
  maxDepth: number
  maxDurationMs: number
}

export const DEFAULT_SESSION_DIRECTORY_SCAN_LIMITS: SessionDirectoryScanLimits = Object.freeze({
  maxEntries: 2_000,
  maxDepth: 8,
  maxDurationMs: 75,
})

export const DEFAULT_SESSION_FILE_POLL_INTERVAL_MS = 1_000
export const DEFAULT_SESSION_FILE_MAX_WATCHED_DIRECTORIES = 128
const DEFAULT_CHANGE_DEBOUNCE_MS = 100

export interface SessionDirectoryScanResult {
  files: SessionFile[]
  fingerprint: string
  scannedEntries: number
  scannedDirectories: number
  truncated: boolean
  reason?: 'entry-limit' | 'depth-limit' | 'time-limit' | 'path-unavailable' | 'unsafe-symlink'
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel))
}

function sortedFiles(files: SessionFile[]): SessionFile[] {
  return files.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

function mixFingerprint(current: number, value: string): number {
  let hash = current
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return hash >>> 0
}

/**
 * Bounded recursive listing used for the file-panel payload and polling only.
 * Observation itself is always non-recursive. Symlinks are skipped.
 */
export async function scanSessionDirectoryBounded(
  rootPath: string,
  limits: SessionDirectoryScanLimits = DEFAULT_SESSION_DIRECTORY_SCAN_LIMITS,
): Promise<SessionDirectoryScanResult> {
  const deadline = Date.now() + limits.maxDurationMs
  let scannedEntries = 0
  let scannedDirectories = 0
  let hash = 2_166_136_261
  let reason: SessionDirectoryScanResult['reason']
  let rootPhysical: string

  try {
    const rootStats = await lstat(rootPath)
    if (rootStats.isSymbolicLink()) {
      return {
        files: [],
        fingerprint: 'unsafe-symlink',
        scannedEntries: 0,
        scannedDirectories: 0,
        truncated: true,
        reason: 'unsafe-symlink',
      }
    }
    if (!rootStats.isDirectory()) throw new Error('Session path is not a directory')
    rootPhysical = await realpath(rootPath)
  } catch {
    return {
      files: [],
      fingerprint: 'path-unavailable',
      scannedEntries: 0,
      scannedDirectories: 0,
      truncated: true,
      reason: 'path-unavailable',
    }
  }

  const scanDirectory = async (dirPath: string, depth: number): Promise<SessionFile[]> => {
    if (reason === 'entry-limit' || reason === 'time-limit') return []
    if (Date.now() > deadline) {
      reason = 'time-limit'
      return []
    }

    scannedDirectories += 1
    let entries: Dirent<string>[]
    try {
      entries = await readdir(dirPath, { withFileTypes: true })
    } catch {
      if (dirPath === rootPath) reason = 'path-unavailable'
      return []
    }

    const files: SessionFile[] = []
    for (const entry of entries) {
      scannedEntries += 1
      if (scannedEntries > limits.maxEntries) {
        reason = 'entry-limit'
        break
      }
      if (Date.now() > deadline) {
        reason = 'time-limit'
        break
      }

      // Internal and hidden entries still consume the safety budget.
      if (entry.name === 'session.jsonl' || entry.name.startsWith('.')) continue
      const fullPath = join(dirPath, entry.name)
      let stats: Awaited<ReturnType<typeof lstat>>
      try {
        stats = await lstat(fullPath)
      } catch {
        continue
      }
      if (stats.isSymbolicLink()) continue

      const relativePath = relative(rootPath, fullPath)

      if (stats.isDirectory()) {
        // Directory mtimes also change for ignored hidden/internal children, so
        // hash only the visible directory identity. Visible descendants carry
        // their own size/mtime entries below.
        hash = mixFingerprint(hash, `${relativePath}:directory:${stats.mode}`)
        let physical: string
        try {
          physical = await realpath(fullPath)
        } catch {
          continue
        }
        if (!isContained(rootPhysical, physical)) continue
        if (depth >= limits.maxDepth) {
          reason ??= 'depth-limit'
          continue
        }
        const children = await scanDirectory(fullPath, depth + 1)
        if (children.length > 0) {
          files.push({ name: entry.name, path: fullPath, type: 'directory', children })
        }
      } else if (stats.isFile()) {
        hash = mixFingerprint(hash, `${relativePath}:file:${stats.mode}:${stats.size}:${stats.mtimeMs}`)
        files.push({ name: entry.name, path: fullPath, type: 'file', size: stats.size })
      }
    }
    return sortedFiles(files)
  }

  const files = await scanDirectory(rootPath, 0)
  return {
    files,
    fingerprint: hash.toString(16),
    scannedEntries,
    scannedDirectories,
    truncated: reason !== undefined,
    reason,
  }
}

export interface SessionFileObserverOptions {
  broker?: DirectoryWatchBroker
  pollIntervalMs?: number
  changeDebounceMs?: number
  maxWatchedDirectories?: number
  scanLimits?: Partial<SessionDirectoryScanLimits>
  scan?: typeof scanSessionDirectoryBounded
}

export interface SessionFileObserverCallbacks {
  onChanged: () => void
  onStatusChange?: (status: SessionFileWatchStatus) => void
  onRemoved?: () => void
}

function mapBrokerReason(state: WatchLeaseState): SessionFileWatchDegradedReason | undefined {
  switch (state.reason) {
    case 'capacity': return 'capacity'
    case 'watch-error': return 'watch-error'
    case 'watch-closed': return 'watch-closed'
    case 'unsafe-symlink': return 'unsafe-symlink'
    case 'missing':
    case 'outside-root':
    case 'invalid-directory':
      return 'path-unavailable'
    default:
      return undefined
  }
}

export class SessionFileObserver {
  private readonly broker: DirectoryWatchBroker
  private readonly pollIntervalMs: number
  private readonly changeDebounceMs: number
  private readonly maxWatchedDirectories: number
  private readonly scanLimits: SessionDirectoryScanLimits
  private readonly scan: typeof scanSessionDirectoryBounded
  private readonly callbacks: SessionFileObserverCallbacks
  private readonly leases = new Map<string, DirectoryWatchLease>()
  private readonly leaseStates = new Map<string, WatchLeaseState>()
  private active = false
  private generation = 0
  private pollTimer?: ReturnType<typeof setInterval>
  private debounceTimer?: ReturnType<typeof setTimeout>
  private pollInFlight = false
  private pollAgain = false
  private skipNextPollNotification = false
  private lastFingerprint?: string
  private localWatchLimitExceeded = false
  private manualReason?: SessionFileWatchDegradedReason
  private lastStatus?: SessionFileWatchStatus

  constructor(
    private readonly sessionPath: string,
    callbacks: SessionFileObserverCallbacks,
    options: SessionFileObserverOptions = {},
  ) {
    this.callbacks = callbacks
    this.broker = options.broker ?? getProcessWatchBroker()
    this.pollIntervalMs = Math.max(25, options.pollIntervalMs ?? DEFAULT_SESSION_FILE_POLL_INTERVAL_MS)
    this.changeDebounceMs = Math.max(0, options.changeDebounceMs ?? DEFAULT_CHANGE_DEBOUNCE_MS)
    this.maxWatchedDirectories = Math.max(1, options.maxWatchedDirectories ?? DEFAULT_SESSION_FILE_MAX_WATCHED_DIRECTORIES)
    this.scanLimits = {
      ...DEFAULT_SESSION_DIRECTORY_SCAN_LIMITS,
      ...options.scanLimits,
    }
    this.scan = options.scan ?? scanSessionDirectoryBounded
  }

  async start(): Promise<SessionFileWatchStatus> {
    if (this.active) return this.getStatus()
    this.active = true
    const generation = ++this.generation

    this.acquireLease('root', this.sessionPath, 'session-panel-root', generation)
    this.refreshDirectChildLeases(generation)

    const baseline = await this.scan(this.sessionPath, this.scanLimits)
    if (!this.isCurrent(generation)) return this.getStatus()
    if (baseline.reason === 'path-unavailable' || baseline.reason === 'unsafe-symlink') {
      this.manualReason = baseline.reason
      this.stopObservation(false)
      this.callbacks.onRemoved?.()
      return this.publishStatus()
    }
    if (baseline.truncated) {
      this.manualReason = baseline.reason
    } else {
      this.lastFingerprint = baseline.fingerprint
      this.startPolling(generation)
    }
    return this.publishStatus()
  }

  getStatus(): SessionFileWatchStatus {
    const activeStates = Array.from(this.leaseStates.values()).filter(state => state.status === 'active')
    let mode: SessionFileWatchStatus['mode'] = 'watching'
    let reason: SessionFileWatchDegradedReason | undefined

    if (this.manualReason) {
      mode = 'manual-refresh'
      reason = this.manualReason
    } else if (this.localWatchLimitExceeded) {
      mode = 'polling'
      reason = 'watch-limit'
    } else {
      const degraded = Array.from(this.leaseStates.values()).find(state => state.status === 'degraded')
      if (degraded) {
        mode = 'polling'
        reason = mapBrokerReason(degraded)
      }
    }

    return {
      mode,
      degraded: mode !== 'watching',
      reason,
      watchedDirectoryCount: activeStates.length,
      ...(mode !== 'manual-refresh' ? { pollingIntervalMs: this.pollIntervalMs } : {}),
      limits: {
        maxEntries: this.scanLimits.maxEntries,
        maxDepth: this.scanLimits.maxDepth,
        maxDurationMs: this.scanLimits.maxDurationMs,
        maxWatchedDirectories: this.maxWatchedDirectories,
      },
    }
  }

  requestReconcile(): void {
    if (!this.active) return
    const generation = this.generation
    for (const lease of this.leases.values()) lease.reconcile()
    this.refreshDirectChildLeases(generation)
    if (this.manualReason) {
      void this.runManualReconcile(generation)
    } else {
      this.requestPoll(generation)
    }
  }

  close(): void {
    if (!this.active && this.leases.size === 0) return
    this.stopObservation(true)
  }

  private acquireLease(
    token: string,
    path: string,
    pathClass: 'session-panel-root' | 'session-panel-child',
    generation: number,
  ): void {
    const lease = this.broker.acquireOptional({
      path,
      pathClass,
      priority: 'session-panel',
      rejectSymlink: true,
      containWithin: pathClass === 'session-panel-child' ? this.sessionPath : dirname(this.sessionPath),
      onEvent: (event) => {
        if (!this.isCurrent(generation)) return
        const filename = event.filename?.replace(/\\/g, '/')
        if (filename && (filename === 'session.jsonl' || filename.startsWith('.'))) return
        if (token === 'root') this.refreshDirectChildLeases(generation)
        if (this.lastFingerprint !== undefined) {
          this.skipNextPollNotification = true
          this.requestPoll(generation)
        }
        this.scheduleChanged(generation)
      },
      onStateChange: (state) => {
        if (!this.isCurrent(generation)) return
        this.leaseStates.set(token, state)
        this.publishStatus()
      },
    })
    this.leases.set(token, lease)
    this.leaseStates.set(token, lease.state)
  }

  private refreshDirectChildLeases(generation: number): void {
    if (!this.isCurrent(generation)) return
    const names: string[] = []
    let hitLocalLimit = false
    let rootPhysical: string
    try {
      const rootStats = lstatSync(this.sessionPath)
      if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) throw new Error('Unsafe session path')
      rootPhysical = realpathSync.native(this.sessionPath)
      const directory = opendirSync(this.sessionPath)
      const deadline = Date.now() + this.scanLimits.maxDurationMs
      let inspectedEntries = 0
      try {
        while (true) {
          if (Date.now() > deadline) {
            hitLocalLimit = true
            break
          }
          const entry = directory.readSync()
          if (!entry) break
          if (inspectedEntries >= this.scanLimits.maxEntries) {
            hitLocalLimit = true
            break
          }
          inspectedEntries += 1
          if (entry.name.startsWith('.') || entry.name === 'session.jsonl') continue
          const fullPath = join(this.sessionPath, entry.name)
          try {
            const stats = lstatSync(fullPath)
            if (stats.isSymbolicLink() || !stats.isDirectory()) continue
            const physical = realpathSync.native(fullPath)
            if (!isContained(rootPhysical, physical)) continue
            names.push(entry.name)
            if (names.length >= this.maxWatchedDirectories) {
              hitLocalLimit = true
              break
            }
          } catch {}
        }
      } finally {
        directory.closeSync()
      }
    } catch {
      this.handleRemoved(generation)
      return
    }

    names.sort()
    const allowed = names.slice(0, Math.max(0, this.maxWatchedDirectories - 1))
    const wanted = new Set(allowed.map(name => `child:${name}`))
    this.localWatchLimitExceeded = hitLocalLimit || names.length > allowed.length

    for (const [token, lease] of this.leases) {
      if (token === 'root' || wanted.has(token)) continue
      lease.close()
      this.leases.delete(token)
      this.leaseStates.delete(token)
    }
    for (const name of allowed) {
      const token = `child:${name}`
      if (!this.leases.has(token)) {
        this.acquireLease(token, join(this.sessionPath, name), 'session-panel-child', generation)
      }
    }
    this.publishStatus()
  }

  private startPolling(generation: number): void {
    if (this.pollTimer || !this.isCurrent(generation)) return
    this.pollTimer = setInterval(() => this.requestPoll(generation), this.pollIntervalMs)
    this.pollTimer.unref?.()
  }

  private requestPoll(generation: number): void {
    if (!this.isCurrent(generation) || this.manualReason) return
    if (this.pollInFlight) {
      this.pollAgain = true
      return
    }
    this.pollInFlight = true
    void this.runPoll(generation).finally(() => {
      this.pollInFlight = false
      if (this.pollAgain && this.isCurrent(generation)) {
        this.pollAgain = false
        this.requestPoll(generation)
      }
    })
  }

  private async runManualReconcile(generation: number): Promise<void> {
    const result = await this.scan(this.sessionPath, this.scanLimits)
    if (!this.isCurrent(generation)) return
    if (result.reason === 'path-unavailable' || result.reason === 'unsafe-symlink') {
      this.handleRemoved(generation)
      return
    }
    if (result.truncated) {
      this.manualReason = result.reason
      this.publishStatus()
      return
    }

    this.manualReason = undefined
    this.lastFingerprint = result.fingerprint
    this.startPolling(generation)
    this.publishStatus()
    this.callbacks.onChanged()
  }

  private async runPoll(generation: number): Promise<void> {
    const result = await this.scan(this.sessionPath, this.scanLimits)
    if (!this.isCurrent(generation)) return
    if (result.reason === 'path-unavailable' || result.reason === 'unsafe-symlink') {
      this.handleRemoved(generation)
      return
    }
    if (result.truncated) {
      this.manualReason = result.reason
      if (this.pollTimer) clearInterval(this.pollTimer)
      this.pollTimer = undefined
      this.publishStatus()
      return
    }

    this.refreshDirectChildLeases(generation)
    if (this.lastFingerprint !== undefined && result.fingerprint !== this.lastFingerprint) {
      if (!this.skipNextPollNotification) this.scheduleChanged(generation)
    }
    this.skipNextPollNotification = false
    this.lastFingerprint = result.fingerprint
  }

  private scheduleChanged(generation: number): void {
    if (!this.isCurrent(generation)) return
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined
      if (!this.isCurrent(generation)) return
      this.callbacks.onChanged()
    }, this.changeDebounceMs)
  }

  private handleRemoved(generation: number): void {
    if (!this.isCurrent(generation)) return
    this.manualReason = 'path-unavailable'
    this.stopObservation(false)
    this.callbacks.onRemoved?.()
    this.callbacks.onChanged()
    this.publishStatus()
  }

  private stopObservation(invalidateGeneration: boolean): void {
    this.active = false
    if (invalidateGeneration) ++this.generation
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.pollTimer = undefined
    this.debounceTimer = undefined
    this.pollAgain = false
    this.skipNextPollNotification = false
    for (const lease of this.leases.values()) lease.close()
    this.leases.clear()
    this.leaseStates.clear()
  }

  private publishStatus(): SessionFileWatchStatus {
    const status = this.getStatus()
    const serialized = JSON.stringify(status)
    if (!this.lastStatus || JSON.stringify(this.lastStatus) !== serialized) {
      this.lastStatus = status
      this.callbacks.onStatusChange?.(status)
    }
    return status
  }

  private isCurrent(generation: number): boolean {
    return this.active && this.generation === generation
  }
}
