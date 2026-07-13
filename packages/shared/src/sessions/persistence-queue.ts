import { copyFile, open, rename, unlink } from 'fs/promises'
import { encodeSessionHeaderForFile } from './jsonl.js'
import { dirname } from 'path'
import type { StoredSession, SessionHeader } from './types.js'
import { getSessionFilePath, ensureSessionsDir, ensureSessionDir } from './storage.js'
import { toPortablePath } from '../utils/paths.js'
import { createSessionHeader, makeSessionPathPortable, readSessionHeader } from './jsonl.js'
import { debug } from '../utils/debug.js'

interface PendingWrite {
  data: StoredSession
  timer?: ReturnType<typeof setTimeout>
}

interface PersistenceFileHandle {
  writeFile(data: string, encoding: BufferEncoding): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}

export interface SessionPersistenceFsAdapter {
  open(path: string, flags: 'w' | 'r'): Promise<PersistenceFileHandle>
  rename(oldPath: string, newPath: string): Promise<void>
  unlink(path: string): Promise<void>
  copyFile?(source: string, destination: string): Promise<void>
}

const defaultFsAdapter: SessionPersistenceFsAdapter = { open, rename, unlink, copyFile }

function isDestinationReplaceConflict(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EEXIST' || code === 'EPERM' || code === 'EACCES'
}

async function atomicReplace(
  tmpFile: string,
  filePath: string,
  fs: SessionPersistenceFsAdapter,
): Promise<void> {
  try {
    await fs.rename(tmpFile, filePath)
    try { await fs.unlink(`${filePath}.bak`) } catch { /* best-effort stale backup cleanup */ }
    return
  } catch (error) {
    if (!isDestinationReplaceConflict(error)) throw error

    const backupFile = `${filePath}.bak`
    try { await fs.unlink(backupFile) } catch { /* best-effort stale backup cleanup */ }
    try {
      await fs.rename(filePath, backupFile)
    } catch {
      throw error
    }
    try {
      await fs.rename(tmpFile, filePath)
    } catch (replaceError) {
      try {
        await fs.rename(backupFile, filePath)
      } catch (restoreError) {
        if (!fs.copyFile) {
          throw new AggregateError([replaceError, restoreError], `Failed to replace and restore ${filePath}`)
        }
        try {
          await fs.copyFile(backupFile, filePath)
          const restored = await fs.open(filePath, 'r')
          try { await restored.sync() } finally { await restored.close() }
          try { await fs.unlink(backupFile) } catch { /* copied target is authoritative */ }
        } catch (copyError) {
          throw new AggregateError([replaceError, restoreError, copyError], `Failed to replace and restore ${filePath}`)
        }
      }
      throw replaceError
    }
    try { await fs.unlink(backupFile) } catch { /* installed file remains authoritative */ }
  }
}

interface HeaderMetadataSignature {
  name?: string
  labels?: string[]
  isFlagged?: boolean
  isPinned?: boolean
  pinnedAt?: number
  sessionStatus?: string
  permissionMode?: string
  hasUnread?: boolean
  lastReadMessageId?: string
  projectId?: string
  kanbanColumn?: string
  enabledMemorySpaceRefs?: SessionHeader['enabledMemorySpaceRefs']
  memoryWriteTargetRef?: SessionHeader['memoryWriteTargetRef']
  memorySelectionMode?: SessionHeader['memorySelectionMode']
}

function getHeaderMetadataSignature(header: SessionHeader): string {
  const signature: HeaderMetadataSignature = {
    name: header.name,
    labels: header.labels,
    isFlagged: header.isFlagged,
    isPinned: header.isPinned,
    pinnedAt: header.pinnedAt,
    sessionStatus: header.sessionStatus,
    permissionMode: header.permissionMode,
    hasUnread: header.hasUnread,
    lastReadMessageId: header.lastReadMessageId,
    projectId: header.projectId,
    kanbanColumn: header.kanbanColumn,
    enabledMemorySpaceRefs: header.enabledMemorySpaceRefs,
    memoryWriteTargetRef: header.memoryWriteTargetRef,
    memorySelectionMode: header.memorySelectionMode,
  }
  return JSON.stringify(signature)
}

function mergeHeaderWithExternalMetadata(localHeader: SessionHeader, diskHeader: SessionHeader): SessionHeader {
  return {
    ...localHeader,
    name: diskHeader.name,
    labels: diskHeader.labels ? [...diskHeader.labels] : undefined,
    isFlagged: diskHeader.isFlagged,
    isPinned: diskHeader.isPinned,
    pinnedAt: diskHeader.pinnedAt,
    sessionStatus: diskHeader.sessionStatus,
    permissionMode: diskHeader.permissionMode,
    hasUnread: diskHeader.hasUnread,
    lastReadMessageId: diskHeader.lastReadMessageId,
    projectId: diskHeader.projectId,
    kanbanColumn: diskHeader.kanbanColumn,
    enabledMemorySpaceRefs: diskHeader.enabledMemorySpaceRefs?.map(ref => ({ ...ref })),
    memoryWriteTargetRef: diskHeader.memoryWriteTargetRef ? { ...diskHeader.memoryWriteTargetRef } : undefined,
    memorySelectionMode: diskHeader.memorySelectionMode,
  }
}

/**
 * Debounced async session persistence queue.
 * Prevents main thread blocking by using async writes and coalescing
 * rapid successive persist calls into a single write.
 *
 * IMPORTANT: Writes are serialized per-session to prevent race conditions
 * when rapid successive flushes (e.g., clearSessionForRecovery + onSdkSessionIdUpdate)
 * would otherwise write to the same .tmp file concurrently.
 */
class SessionPersistenceQueue {
  private pending = new Map<string, PendingWrite>()
  private writeInProgress = new Map<string, Promise<void>>()
  /** Durable on-disk baseline, updated only after atomic write completion. */
  private lastWrittenHeaderSignature = new Map<string, string>()
  /** Signature being atomically written, used only to suppress fs.watch echoes. */
  private inFlightHeaderSignature = new Map<string, string>()
  private debounceMs: number
  private fs: SessionPersistenceFsAdapter

  constructor(debounceMs = 500, fs: SessionPersistenceFsAdapter = defaultFsAdapter) {
    this.debounceMs = debounceMs
    this.fs = fs
  }

  /**
   * Queue a session for persistence. If a write is already pending for this
   * session, it will be replaced with the new data and the timer reset.
   */
  enqueue(session: StoredSession): void {
    const existing = this.pending.get(session.id)
    if (existing?.timer) clearTimeout(existing.timer)

    const timer = setTimeout(() => {
      // Timer-driven writes must use the same serialized path as explicit
      // flushes; calling write() directly can race on the shared .tmp file.
      void this.flush(session.id).catch(error => {
        console.error(`[PersistenceQueue] Failed to write session ${session.id}:`, error)
      })
    }, this.debounceMs)

    this.pending.set(session.id, { data: session, timer })
  }

  /** Seed the durable baseline when a session header has been loaded from disk. */
  initializeBaseline(sessionId: string, header: SessionHeader): void {
    // A disk scan/load must not redefine authority underneath an already
    // queued or active local mutation. Startup/import/cold-load seeding occurs
    // before enqueue, while concurrent list refreshes safely no-op here.
    if (this.pending.has(sessionId) || this.writeInProgress.has(sessionId)) return
    this.lastWrittenHeaderSignature.set(sessionId, getHeaderMetadataSignature(header))
  }

  /**
   * Write a session to disk immediately in JSONL format.
   * Uses atomic write (write-to-temp-then-rename) to prevent corruption on crash.
   */
  private async write(sessionId: string): Promise<void> {
    const entry = this.pending.get(sessionId)
    if (!entry) return

    this.pending.delete(sessionId)

    try {
      const { data } = entry
      const filePath = getSessionFilePath(data.workspaceRootPath, sessionId)

      // Prepare session with portable paths for cross-machine compatibility
      const storageSession: StoredSession = {
        ...data,
        workspaceRootPath: toPortablePath(data.workspaceRootPath),
        workingDirectory: data.workingDirectory ? toPortablePath(data.workingDirectory) : undefined,
        sdkCwd: data.sdkCwd ? toPortablePath(data.sdkCwd) : undefined,
        lastUsedAt: Date.now(),
      }

      // Create JSONL content: header + messages (one per line)
      // Filter out intermediate messages - they're transient streaming status updates
      const localHeader = createSessionHeader(storageSession)
      const localSig = getHeaderMetadataSignature(localHeader)
      const diskHeader = readSessionHeader(filePath)
      const previousSig = this.lastWrittenHeaderSignature.get(sessionId)
      const diskSig = diskHeader ? getHeaderMetadataSignature(diskHeader) : undefined

      // Queue writes should never clobber session metadata changed externally
      // (watcher edits, direct header edits, other instances), but they must
      // still persist local metadata updates (e.g. generated title).
      //
      // Preserve disk metadata only when disk diverged from our last written
      // signature, which indicates an external mutation.
      const hasMetadataMismatch = !!diskHeader && !!diskSig && diskSig !== localSig
      // A fresh queue has no authority to overwrite an existing disk header:
      // without an initialized baseline, treat a mismatch as external.
      const hasExternalMetadataChange = !!diskHeader && !!diskSig
        && (previousSig === undefined ? diskSig !== localSig : diskSig !== previousSig)
      const header = hasExternalMetadataChange && diskHeader
        ? mergeHeaderWithExternalMetadata(localHeader, diskHeader)
        : localHeader

      if (hasMetadataMismatch) {
        const baseline = previousSig ? `, previousSig=${previousSig.slice(0, 12)}` : ', previousSig=<none>'
        const mode = hasExternalMetadataChange ? 'disk preserved' : 'local preserved'
        debug(`[PersistenceQueue] Session ${sessionId} metadata mismatch detected (${mode}${baseline})`)
      }

      const persistableMessages = storageSession.messages
      // Use original absolute sessionDir (before toPortablePath) for path replacement
      const sessionDir = dirname(filePath)
      const headerLine = encodeSessionHeaderForFile(filePath, header)
      const lines = [
        headerLine,
        ...persistableMessages.map(m => makeSessionPathPortable(JSON.stringify(m), sessionDir)),
      ]

      // Atomic write: write + fsync temporary file, then rename. Durable
      // baseline advances only after the rename succeeds; failures retain the
      // pending local write so a later flush can retry it.
      const finalSignature = getHeaderMetadataSignature(header)
      this.inFlightHeaderSignature.set(sessionId, finalSignature)
      const tmpFile = `${filePath}.tmp`
      try {
        // Header cap validation above is intentionally before any directory side effect.
        ensureSessionsDir(data.workspaceRootPath)
        ensureSessionDir(data.workspaceRootPath, sessionId)
        try {
          const handle = await this.fs.open(tmpFile, 'w')
          try {
            await handle.writeFile(lines.join('\n') + '\n', 'utf-8')
            await handle.sync()
          } finally {
            await handle.close()
          }
          await atomicReplace(tmpFile, filePath, this.fs)
        } catch (error) {
          try { await this.fs.unlink(tmpFile) } catch { /* best-effort failed-write cleanup */ }
          throw error
        }
        this.lastWrittenHeaderSignature.set(sessionId, finalSignature)
        debug(`[PersistenceQueue] Wrote session ${sessionId}`)
      } finally {
        this.inFlightHeaderSignature.delete(sessionId)
      }
    } catch (error) {
      // Do not replace a newer queued update with this failed write.
      if (!this.pending.has(sessionId)) this.pending.set(sessionId, { data: entry.data })
      throw error
    }
  }

  /**
   * Immediately flush a specific session if pending.
   * Waits for any in-progress write to complete before starting a new one
   * to prevent race conditions on the shared .tmp file.
   */
  async flush(sessionId: string): Promise<void> {
    const entry = this.pending.get(sessionId)
    if (entry?.timer) clearTimeout(entry.timer)

    // Wait for any timer- or caller-initiated write. Re-enter afterward so a
    // newer update queued during that write is serialized behind it, and so
    // concurrent flush callers also wait for the newest tracked write.
    const inProgress = this.writeInProgress.get(sessionId)
    if (inProgress) {
      await inProgress
      return this.flush(sessionId)
    }

    if (!this.pending.has(sessionId)) return

    const writePromise = this.write(sessionId)
    this.writeInProgress.set(sessionId, writePromise)

    try {
      await writePromise
    } finally {
      if (this.writeInProgress.get(sessionId) === writePromise) {
        this.writeInProgress.delete(sessionId)
      }
    }
  }

  /**
   * Cancel a pending write for a session (e.g., when deleting the session).
   */
  cancel(sessionId: string): void {
    const entry = this.pending.get(sessionId)
    if (entry) {
      if (entry.timer) clearTimeout(entry.timer)
      this.pending.delete(sessionId)
      debug(`[PersistenceQueue] Cancelled pending write for session ${sessionId}`)
    }
    this.lastWrittenHeaderSignature.delete(sessionId)
    this.inFlightHeaderSignature.delete(sessionId)
  }

  /**
   * Flush all pending sessions. Call this on app quit.
   */
  async flushAll(): Promise<void> {
    const sessionIds = [...this.pending.keys()]
    await Promise.all(sessionIds.map(id => this.flush(id)))
  }

  /**
   * Check if a session has a pending write.
   */
  hasPending(sessionId: string): boolean {
    return this.pending.has(sessionId)
  }

  /**
   * Get the metadata signature of the last header we wrote for a session.
   * Used by ConfigWatcher to suppress self-triggered metadata change events.
   */
  getLastWrittenSignature(sessionId: string): string | undefined {
    return this.inFlightHeaderSignature.get(sessionId) ?? this.lastWrittenHeaderSignature.get(sessionId)
  }

  /**
   * Get count of pending writes.
   */
  get pendingCount(): number {
    return this.pending.size
  }
}

// Singleton instance
export const sessionPersistenceQueue = new SessionPersistenceQueue()

// Named exports for testing/customization
export { SessionPersistenceQueue, getHeaderMetadataSignature, mergeHeaderWithExternalMetadata }
