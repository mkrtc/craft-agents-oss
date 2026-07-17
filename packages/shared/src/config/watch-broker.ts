import {
  NodeDirectoryWatchAdapter,
  WatchPathError,
  getWatchErrorCode,
  type DirectoryIdentity,
  type DirectoryInspectionOptions,
  type DirectoryWatchAdapter,
  type DirectoryWatchEvent,
  type DirectoryWatchHandle,
} from './watch-adapter.ts';
import type {
  WatchBrokerSnapshot,
  WatchDegradedReason,
  WatchDiagnostic,
  WatchLeasePriority,
  WatchLeaseState,
  WatchPathClass,
} from './watch-diagnostics.ts';

export const DEFAULT_WATCH_DIRECTORY_CAPACITY = 8192;

export interface DirectoryWatchRequest extends DirectoryInspectionOptions {
  path: string;
  pathClass: WatchPathClass;
  priority: WatchLeasePriority;
  onEvent: (event: DirectoryWatchEvent) => void;
  onStateChange?: (state: WatchLeaseState) => void;
  onDiagnostic?: (diagnostic: WatchDiagnostic) => void;
}

export interface DirectoryWatchLease {
  readonly id: number;
  readonly state: WatchLeaseState;
  close(): void;
  /** One caller-requested retry/reconciliation attempt. */
  reconcile(): void;
}

export interface DirectoryWatchBrokerOptions {
  capacity?: number;
  adapter?: DirectoryWatchAdapter;
  /** Set to zero to disable changed-path reconciliation (useful for deterministic tests). */
  reconcileIntervalMs?: number;
  reconcileBatchSize?: number;
}

export class WatchCapacityError extends Error {
  readonly capacity: number;
  readonly requiredDirectoryCount: number;

  constructor(capacity: number, requiredDirectoryCount: number) {
    super(`Required directory watches exceed broker capacity (${requiredDirectoryCount} > ${capacity})`);
    this.name = 'WatchCapacityError';
    this.capacity = capacity;
    this.requiredDirectoryCount = requiredDirectoryCount;
  }
}

export class WatchAcquisitionError extends Error {
  readonly pathClass: WatchPathClass;
  readonly code?: string;

  constructor(pathClass: WatchPathClass, cause: unknown) {
    super(`Failed to acquire required ${pathClass} directory watch`, { cause });
    this.name = 'WatchAcquisitionError';
    this.pathClass = pathClass;
    this.code = getWatchErrorCode(cause);
  }
}

interface LeaseRecord {
  id: number;
  request: DirectoryWatchRequest;
  state: WatchLeaseState;
  entryKey?: string;
  closed: boolean;
  inspectionFailure?: WatchPathError;
}

interface WatchEntry {
  identity: DirectoryIdentity;
  leaseIds: Set<number>;
  watcher?: DirectoryWatchHandle;
  watchGeneration: number;
  capacityBlocked: boolean;
  quarantineReason?: WatchDegradedReason;
  errorCode?: string;
  retryArmed: boolean;
  createdOrder: number;
}

function errorReason(error: unknown): WatchDegradedReason {
  return error instanceof WatchPathError ? error.reason : 'watch-error';
}

function priorityRank(priority: WatchLeasePriority): number {
  switch (priority) {
    case 'required': return 100;
    case 'source': return 30;
    case 'skill': return 30;
    case 'session': return 20;
    case 'session-panel': return 10;
  }
}

function isRequired(record: LeaseRecord | undefined): boolean {
  return record?.request.priority === 'required';
}

function safeInvoke<T extends unknown[]>(callback: ((...args: T) => void) | undefined, ...args: T): void {
  if (!callback) return;
  try {
    callback(...args);
  } catch {
    // Filesystem notification consumers must never destabilize the broker.
  }
}

export class DirectoryWatchBroker {
  readonly capacity: number;

  private readonly adapter: DirectoryWatchAdapter;
  private readonly entries = new Map<string, WatchEntry>();
  private readonly leases = new Map<number, LeaseRecord>();
  private readonly reconcileIntervalMs: number;
  private readonly reconcileBatchSize: number;
  private nextLeaseId = 1;
  private nextEntryOrder = 1;
  private reconcileCursor = 0;
  private reconcileTimer?: ReturnType<typeof setInterval>;
  private suppressRecovery = 0;
  private closed = false;

  constructor(options: DirectoryWatchBrokerOptions = {}) {
    this.capacity = Math.max(0, Math.floor(options.capacity ?? DEFAULT_WATCH_DIRECTORY_CAPACITY));
    this.adapter = options.adapter ?? new NodeDirectoryWatchAdapter();
    this.reconcileIntervalMs = Math.max(0, options.reconcileIntervalMs ?? 1000);
    this.reconcileBatchSize = Math.max(1, options.reconcileBatchSize ?? 128);
  }

  acquireRequired(requests: DirectoryWatchRequest[]): DirectoryWatchLease[] {
    this.assertOpen();
    const inspected = requests.map((request) => ({
      request,
      identity: this.adapter.inspect(request.path, request),
    }));

    const requiredKeys = new Set<string>();
    for (const { identity } of inspected) {
      if (identity.present && !this.entries.get(identity.key)?.watcher) requiredKeys.add(identity.key);
    }

    const activeCount = this.activeDirectoryCount();
    const evictableCount = Array.from(this.entries.values())
      .filter((entry) => !!entry.watcher && !this.entryIsRequired(entry))
      .length;
    if (requiredKeys.size > this.capacity - activeCount + evictableCount) {
      // Preflight before eviction so a transaction that cannot possibly fit
      // leaves existing optional observation untouched.
      throw new WatchCapacityError(this.capacity, activeCount + requiredKeys.size);
    }

    const needed = Math.max(0, requiredKeys.size - (this.capacity - activeCount));
    if (needed > 0) this.evictOptionalEntries(needed);

    const acquired: DirectoryWatchLease[] = [];
    this.suppressRecovery += 1;
    try {
      for (const { request, identity } of inspected) {
        acquired.push(this.acquireInspected(request, identity, true));
      }
      return acquired;
    } catch (error) {
      for (const lease of acquired) lease.close();
      throw error;
    } finally {
      this.suppressRecovery -= 1;
      if (this.suppressRecovery === 0) this.recoverAvailableCapacity();
    }
  }

  acquireOptional(request: DirectoryWatchRequest): DirectoryWatchLease {
    this.assertOpen();
    let identity: DirectoryIdentity;
    try {
      identity = this.adapter.inspect(request.path, request);
    } catch (error) {
      const failure = error instanceof WatchPathError
        ? error
        : new WatchPathError('Unable to inspect optional watch directory', 'invalid-directory', getWatchErrorCode(error));
      return this.acquireInspectionFailure(request, failure);
    }
    return this.acquireInspected(request, identity, false);
  }

  getSnapshot(): WatchBrokerSnapshot {
    const countsByPathClass: WatchBrokerSnapshot['countsByPathClass'] = {};
    let pendingLeaseCount = 0;
    for (const record of this.leases.values()) {
      if (record.closed) continue;
      countsByPathClass[record.request.pathClass] = (countsByPathClass[record.request.pathClass] ?? 0) + 1;
      if (record.state.status === 'degraded') pendingLeaseCount += 1;
    }

    let placeholderDirectoryCount = 0;
    let quarantinedDirectoryCount = 0;
    for (const entry of this.entries.values()) {
      if (!entry.identity.present) placeholderDirectoryCount += 1;
      if (entry.quarantineReason) quarantinedDirectoryCount += 1;
    }

    return {
      capacity: this.capacity,
      activeDirectoryCount: this.activeDirectoryCount(),
      placeholderDirectoryCount,
      quarantinedDirectoryCount,
      leaseCount: this.leases.size,
      pendingLeaseCount,
      countsByPathClass,
    };
  }

  /**
   * Reconcile only paths whose existence or physical directory identity changed.
   * Persistent watch errors on an unchanged inode remain quarantined.
   */
  reconcileChanged(maxEntries = this.reconcileBatchSize): void {
    if (this.closed) return;
    const entries = Array.from(this.entries.values());
    if (entries.length === 0) return;

    const count = Math.min(maxEntries, entries.length);
    for (let offset = 0; offset < count; offset += 1) {
      const index = (this.reconcileCursor + offset) % entries.length;
      const entry = entries[index]!;
      this.reconcileEntry(entry, false);
    }
    this.reconcileCursor = (this.reconcileCursor + count) % entries.length;

    const detached = Array.from(this.leases.values())
      .filter((record) => !record.closed && !record.entryKey)
      .slice(0, Math.max(0, maxEntries - count));
    for (const record of detached) this.reconcileDetachedLease(record, false);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = undefined;

    this.suppressRecovery += 1;
    try {
      for (const record of Array.from(this.leases.values())) this.releaseLease(record.id);
    } finally {
      this.suppressRecovery -= 1;
      this.entries.clear();
      this.leases.clear();
    }
  }

  private acquireInspectionFailure(
    request: DirectoryWatchRequest,
    failure: WatchPathError,
  ): DirectoryWatchLease {
    const record = this.createLeaseRecord(request);
    record.inspectionFailure = failure;
    this.transition(record, {
      status: 'degraded',
      pathClass: request.pathClass,
      priority: request.priority,
      reason: failure.reason,
      errorCode: failure.code,
    }, 'degraded');
    this.ensureReconcileTimer();
    return this.publicLease(record);
  }

  private acquireInspected(
    request: DirectoryWatchRequest,
    identity: DirectoryIdentity,
    requiredTransaction: boolean,
  ): DirectoryWatchLease {
    const record = this.createLeaseRecord(request);
    let entry = this.entries.get(identity.key);
    const shared = !!entry;
    if (!entry) {
      entry = {
        identity,
        leaseIds: new Set(),
        watchGeneration: 0,
        capacityBlocked: false,
        retryArmed: false,
        createdOrder: this.nextEntryOrder++,
      };
      this.entries.set(identity.key, entry);
    }

    entry.leaseIds.add(record.id);
    record.entryKey = entry.identity.key;

    if (!identity.present) {
      this.transition(record, {
        status: 'degraded',
        pathClass: request.pathClass,
        priority: request.priority,
        reason: 'missing',
      }, 'degraded');
    } else if (entry.watcher) {
      this.transition(record, {
        status: 'active',
        pathClass: request.pathClass,
        priority: request.priority,
      }, shared ? 'shared' : 'acquired');
    } else if (this.activeDirectoryCount() >= this.capacity && request.priority !== 'required') {
      entry.capacityBlocked = true;
      this.transition(record, {
        status: 'degraded',
        pathClass: request.pathClass,
        priority: request.priority,
        reason: 'capacity',
      }, 'capacity');
    } else {
      try {
        this.attachEntry(entry);
      } catch (error) {
        if (requiredTransaction || request.priority === 'required') {
          this.detachLeaseRecord(record, false);
          throw new WatchAcquisitionError(request.pathClass, error);
        }
      }
    }

    this.ensureReconcileTimer();
    return this.publicLease(record);
  }

  private createLeaseRecord(request: DirectoryWatchRequest): LeaseRecord {
    const record: LeaseRecord = {
      id: this.nextLeaseId++,
      request,
      state: {
        status: 'degraded',
        pathClass: request.pathClass,
        priority: request.priority,
        reason: 'missing',
      },
      closed: false,
    };
    this.leases.set(record.id, record);
    return record;
  }

  private publicLease(record: LeaseRecord): DirectoryWatchLease {
    const broker = this;
    return {
      id: record.id,
      get state() {
        return { ...record.state };
      },
      close() {
        broker.releaseLease(record.id);
      },
      reconcile() {
        if (record.closed || broker.closed) return;
        if (record.entryKey) {
          const entry = broker.entries.get(record.entryKey);
          if (entry) broker.reconcileEntry(entry, true);
        } else {
          broker.reconcileDetachedLease(record, true);
        }
      },
    };
  }

  private attachEntry(entry: WatchEntry): void {
    if (entry.watcher || !entry.identity.present) return;

    const required = this.entryIsRequired(entry);
    if (this.activeDirectoryCount() >= this.capacity) {
      if (required) this.evictOptionalEntries(1);
      if (this.activeDirectoryCount() >= this.capacity) {
        entry.capacityBlocked = true;
        this.transitionEntry(entry, 'capacity', undefined, 'capacity');
        if (required) {
          throw new WatchCapacityError(this.capacity, this.activeDirectoryCount() + 1);
        }
        return;
      }
    }

    const generation = ++entry.watchGeneration;
    let watcher!: DirectoryWatchHandle;
    try {
      watcher = this.adapter.watch(entry.identity.watchPath, (event) => {
        if (entry.watchGeneration !== generation || entry.watcher !== watcher) return;
        for (const leaseId of Array.from(entry.leaseIds)) {
          const record = this.leases.get(leaseId);
          if (!record || record.closed) continue;
          safeInvoke(record.request.onEvent, event);
        }
      });
    } catch (error) {
      entry.capacityBlocked = false;
      entry.quarantineReason = errorReason(error);
      entry.errorCode = getWatchErrorCode(error);
      entry.retryArmed = true;
      this.transitionEntry(entry, entry.quarantineReason, entry.errorCode, 'error');
      throw error;
    }

    entry.watcher = watcher;
    watcher.on('error', (error) => {
      if (entry.watchGeneration !== generation || entry.watcher !== watcher) return;
      this.handleWatcherFailure(entry, 'watch-error', error);
    });
    watcher.on('close', () => {
      if (entry.watchGeneration !== generation || entry.watcher !== watcher) return;
      this.handleWatcherFailure(entry, 'watch-closed');
    });

    const wasDegraded = Array.from(entry.leaseIds).some((id) => this.leases.get(id)?.state.status === 'degraded');
    entry.capacityBlocked = false;
    entry.quarantineReason = undefined;
    entry.errorCode = undefined;
    entry.retryArmed = false;
    for (const leaseId of entry.leaseIds) {
      const record = this.leases.get(leaseId);
      if (!record || record.closed) continue;
      this.transition(record, {
        status: 'active',
        pathClass: record.request.pathClass,
        priority: record.request.priority,
      }, wasDegraded ? 'recovered' : (entry.leaseIds.size > 1 ? 'shared' : 'acquired'));
    }
  }

  private handleWatcherFailure(
    entry: WatchEntry,
    reason: 'watch-error' | 'watch-closed',
    error?: Error,
  ): void {
    ++entry.watchGeneration;
    const watcher = entry.watcher;
    entry.watcher = undefined;
    if (reason === 'watch-error') {
      try { watcher?.close(); } catch {}
    }
    entry.capacityBlocked = false;
    entry.quarantineReason = reason;
    entry.errorCode = getWatchErrorCode(error);
    entry.retryArmed = true;
    this.transitionEntry(entry, reason, entry.errorCode, reason === 'watch-error' ? 'error' : 'closed');
    // The released slot may recover other pending/quarantined entries, but the
    // failing entry is excluded by key and therefore cannot trigger itself.
    this.recoverAvailableCapacity(entry.identity.key);
  }

  private transitionEntry(
    entry: WatchEntry,
    reason: WatchDegradedReason,
    code: string | undefined,
    diagnosticType: WatchDiagnostic['type'],
  ): void {
    for (const leaseId of entry.leaseIds) {
      const record = this.leases.get(leaseId);
      if (!record || record.closed) continue;
      this.transition(record, {
        status: 'degraded',
        pathClass: record.request.pathClass,
        priority: record.request.priority,
        reason,
        errorCode: code,
      }, diagnosticType);
    }
  }

  private transition(
    record: LeaseRecord,
    state: WatchLeaseState,
    diagnosticType: WatchDiagnostic['type'],
  ): void {
    const changed = record.state.status !== state.status
      || record.state.reason !== state.reason
      || record.state.errorCode !== state.errorCode;
    record.state = state;
    if (changed) safeInvoke(record.request.onStateChange, { ...state });
    this.emitDiagnostic(record, diagnosticType, state.reason, state.errorCode);
  }

  private emitDiagnostic(
    record: LeaseRecord,
    type: WatchDiagnostic['type'],
    reason?: WatchDegradedReason,
    code?: string,
  ): void {
    safeInvoke(record.request.onDiagnostic, {
      type,
      pathClass: record.request.pathClass,
      priority: record.request.priority,
      activeDirectoryCount: this.activeDirectoryCount(),
      leaseCount: this.leases.size,
      capacity: this.capacity,
      reason,
      errorCode: code,
    });
  }

  private releaseLease(id: number): void {
    const record = this.leases.get(id);
    if (!record || record.closed) return;
    const releasedKey = record.entryKey;
    const releasedCapacity = this.detachLeaseRecord(record, true);
    if (this.leases.size === 0 && this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }
    if (this.suppressRecovery === 0 && releasedCapacity) this.recoverAvailableCapacity(releasedKey);
  }

  private detachLeaseRecord(record: LeaseRecord, emitReleased: boolean): boolean {
    if (record.closed) return false;
    let releasedCapacity = false;
    record.closed = true;
    record.state = {
      status: 'closed',
      pathClass: record.request.pathClass,
      priority: record.request.priority,
    };
    safeInvoke(record.request.onStateChange, { ...record.state });

    const entry = record.entryKey ? this.entries.get(record.entryKey) : undefined;
    if (entry) {
      entry.leaseIds.delete(record.id);
      if (entry.leaseIds.size === 0) {
        ++entry.watchGeneration;
        const watcher = entry.watcher;
        releasedCapacity = !!watcher;
        entry.watcher = undefined;
        try { watcher?.close(); } catch {}
        this.entries.delete(entry.identity.key);
      }
    }
    record.entryKey = undefined;
    record.inspectionFailure = undefined;
    this.leases.delete(record.id);
    if (emitReleased) this.emitDiagnostic(record, 'released');
    return releasedCapacity;
  }

  private evictOptionalEntries(count: number): void {
    if (count <= 0) return;
    const candidates = Array.from(this.entries.values())
      .filter((entry) => !!entry.watcher && !this.entryIsRequired(entry))
      .sort((a, b) => {
        const aRank = this.entryPriorityRank(a);
        const bRank = this.entryPriorityRank(b);
        return aRank - bRank || a.createdOrder - b.createdOrder;
      });

    for (const entry of candidates.slice(0, count)) {
      ++entry.watchGeneration;
      const watcher = entry.watcher;
      entry.watcher = undefined;
      try { watcher?.close(); } catch {}
      entry.capacityBlocked = true;
      entry.quarantineReason = undefined;
      entry.errorCode = undefined;
      entry.retryArmed = false;
      this.transitionEntry(entry, 'capacity', undefined, 'capacity');
    }
  }

  private recoverAvailableCapacity(releasedKey?: string): void {
    if (this.closed || this.activeDirectoryCount() >= this.capacity) return;

    // A quarantined entry gets at most one retry on an unrelated release.
    const quarantined = Array.from(this.entries.values())
      .filter((entry) => entry.identity.key !== releasedKey && !entry.watcher && entry.retryArmed);
    for (const entry of quarantined) {
      if (this.activeDirectoryCount() >= this.capacity) break;
      entry.retryArmed = false;
      try { this.attachEntry(entry); } catch {
        // Keep quarantined and unarmed until explicit reconciliation or identity change.
        entry.retryArmed = false;
      }
    }

    const capacityBlocked = Array.from(this.entries.values())
      .filter((entry) => entry.capacityBlocked && !entry.watcher && entry.identity.present)
      .sort((a, b) => this.entryPriorityRank(b) - this.entryPriorityRank(a) || a.createdOrder - b.createdOrder);
    for (const entry of capacityBlocked) {
      if (this.activeDirectoryCount() >= this.capacity) break;
      try { this.attachEntry(entry); } catch {}
    }
  }

  private reconcileEntry(entry: WatchEntry, explicit: boolean): void {
    const records = Array.from(entry.leaseIds)
      .map((id) => this.leases.get(id))
      .filter((record): record is LeaseRecord => !!record && !record.closed);
    if (records.length === 0) return;

    let nextIdentity: DirectoryIdentity | undefined;
    let inspectionFailure: WatchPathError | undefined;
    for (const record of records) {
      try {
        nextIdentity = this.adapter.inspect(record.request.path, record.request);
        record.inspectionFailure = undefined;
        break;
      } catch (error) {
        inspectionFailure = error instanceof WatchPathError
          ? error
          : new WatchPathError('Unable to inspect watch directory', 'invalid-directory', getWatchErrorCode(error));
      }
    }

    if (!nextIdentity) {
      if (entry.watcher) {
        ++entry.watchGeneration;
        const watcher = entry.watcher;
        entry.watcher = undefined;
        try { watcher?.close(); } catch {}
      }
      entry.quarantineReason = inspectionFailure?.reason ?? 'invalid-directory';
      entry.errorCode = inspectionFailure?.code;
      entry.retryArmed = false;
      this.transitionEntry(entry, entry.quarantineReason, entry.errorCode, 'degraded');
      return;
    }

    const identityChanged = nextIdentity.key !== entry.identity.key
      || nextIdentity.fingerprint !== entry.identity.fingerprint
      || nextIdentity.watchPath !== entry.identity.watchPath;

    if (nextIdentity.key !== entry.identity.key) {
      this.rekeyEntry(entry, nextIdentity);
      const current = this.entries.get(nextIdentity.key);
      if (current && (identityChanged || explicit || !current.watcher)) {
        this.tryAttachAfterReconcile(current, explicit || identityChanged);
      }
      return;
    }

    entry.identity = nextIdentity;
    if (identityChanged && entry.watcher) {
      ++entry.watchGeneration;
      const watcher = entry.watcher;
      entry.watcher = undefined;
      try { watcher?.close(); } catch {}
    }

    if (!nextIdentity.present) {
      entry.quarantineReason = 'missing';
      entry.errorCode = undefined;
      entry.retryArmed = false;
      this.transitionEntry(entry, 'missing', undefined, 'degraded');
      return;
    }

    if (identityChanged || explicit || entry.capacityBlocked) {
      this.tryAttachAfterReconcile(entry, explicit || identityChanged);
    }
  }

  private tryAttachAfterReconcile(entry: WatchEntry, allowQuarantineRetry: boolean): void {
    if (entry.watcher) return;
    if (entry.quarantineReason && !entry.capacityBlocked && !allowQuarantineRetry) return;
    if (allowQuarantineRetry) entry.retryArmed = false;
    try { this.attachEntry(entry); } catch {
      entry.retryArmed = false;
    }
  }

  private rekeyEntry(entry: WatchEntry, nextIdentity: DirectoryIdentity): void {
    const oldKey = entry.identity.key;
    const target = this.entries.get(nextIdentity.key);
    if (target && target !== entry) {
      ++entry.watchGeneration;
      const watcher = entry.watcher;
      entry.watcher = undefined;
      try { watcher?.close(); } catch {}
      this.entries.delete(oldKey);
      for (const leaseId of entry.leaseIds) {
        target.leaseIds.add(leaseId);
        const record = this.leases.get(leaseId);
        if (record) record.entryKey = target.identity.key;
      }
      entry.leaseIds.clear();
      if (target.watcher) {
        for (const leaseId of target.leaseIds) {
          const record = this.leases.get(leaseId);
          if (!record || record.closed) continue;
          this.transition(record, {
            status: 'active',
            pathClass: record.request.pathClass,
            priority: record.request.priority,
          }, 'shared');
        }
      }
      return;
    }

    if (entry.watcher) {
      ++entry.watchGeneration;
      const watcher = entry.watcher;
      entry.watcher = undefined;
      try { watcher.close(); } catch {}
    }
    this.entries.delete(oldKey);
    entry.identity = nextIdentity;
    this.entries.set(nextIdentity.key, entry);
    for (const leaseId of entry.leaseIds) {
      const record = this.leases.get(leaseId);
      if (record) record.entryKey = nextIdentity.key;
    }
  }

  private reconcileDetachedLease(record: LeaseRecord, _explicit: boolean): void {
    let identity: DirectoryIdentity;
    try {
      identity = this.adapter.inspect(record.request.path, record.request);
    } catch (error) {
      const failure = error instanceof WatchPathError
        ? error
        : new WatchPathError('Unable to inspect watch directory', 'invalid-directory', getWatchErrorCode(error));
      record.inspectionFailure = failure;
      this.transition(record, {
        status: 'degraded',
        pathClass: record.request.pathClass,
        priority: record.request.priority,
        reason: failure.reason,
        errorCode: failure.code,
      }, 'degraded');
      return;
    }

    record.inspectionFailure = undefined;
    const existing = this.entries.get(identity.key);
    const entry = existing ?? {
      identity,
      leaseIds: new Set<number>(),
      watchGeneration: 0,
      capacityBlocked: false,
      retryArmed: false,
      createdOrder: this.nextEntryOrder++,
    };
    if (!existing) this.entries.set(identity.key, entry);
    entry.leaseIds.add(record.id);
    record.entryKey = identity.key;
    if (entry.watcher) {
      this.transition(record, {
        status: 'active',
        pathClass: record.request.pathClass,
        priority: record.request.priority,
      }, 'shared');
      return;
    }
    if (!identity.present) {
      this.transition(record, {
        status: 'degraded',
        pathClass: record.request.pathClass,
        priority: record.request.priority,
        reason: 'missing',
      }, 'degraded');
      return;
    }
    this.tryAttachAfterReconcile(entry, true);
  }

  private entryIsRequired(entry: WatchEntry): boolean {
    return Array.from(entry.leaseIds).some((id) => isRequired(this.leases.get(id)));
  }

  private entryPriorityRank(entry: WatchEntry): number {
    let rank = 0;
    for (const id of entry.leaseIds) {
      const record = this.leases.get(id);
      if (record) rank = Math.max(rank, priorityRank(record.request.priority));
    }
    return rank;
  }

  private activeDirectoryCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.watcher) count += 1;
    }
    return count;
  }

  private ensureReconcileTimer(): void {
    if (this.reconcileIntervalMs === 0 || this.reconcileTimer || this.closed) return;
    this.reconcileTimer = setInterval(() => {
      this.reconcileChanged();
    }, this.reconcileIntervalMs);
    this.reconcileTimer.unref?.();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('DirectoryWatchBroker is closed');
  }
}

function configuredCapacity(): number {
  const raw = process.env.CRAFT_WATCH_DIRECTORY_CAP;
  if (!raw) return DEFAULT_WATCH_DIRECTORY_CAPACITY;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_WATCH_DIRECTORY_CAPACITY;
}

let processWatchBroker: DirectoryWatchBroker | undefined;

export function getProcessWatchBroker(): DirectoryWatchBroker {
  processWatchBroker ??= new DirectoryWatchBroker({ capacity: configuredCapacity() });
  return processWatchBroker;
}
