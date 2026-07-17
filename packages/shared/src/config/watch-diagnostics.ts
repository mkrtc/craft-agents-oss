export type WatchPathClass =
  | 'global-config'
  | 'app-themes'
  | 'app-permissions'
  | 'workspace-root'
  | 'sources-root'
  | 'source-child'
  | 'skills-root'
  | 'skill-child'
  | 'sessions-root'
  | 'session-child'
  | 'statuses-root'
  | 'status-icons'
  | 'labels-root'
  | 'session-panel-root'
  | 'session-panel-child';

export type WatchLeasePriority = 'required' | 'source' | 'skill' | 'session' | 'session-panel';

export type WatchDegradedReason =
  | 'capacity'
  | 'missing'
  | 'watch-error'
  | 'watch-closed'
  | 'unsafe-symlink'
  | 'outside-root'
  | 'invalid-directory';

export interface WatchLeaseState {
  status: 'active' | 'degraded' | 'closed';
  pathClass: WatchPathClass;
  priority: WatchLeasePriority;
  reason?: WatchDegradedReason;
  errorCode?: string;
}

/**
 * Content-free watch diagnostics. Paths and filenames are intentionally absent:
 * diagnostics may be logged or exported without disclosing user content.
 */
export interface WatchDiagnostic {
  type:
    | 'acquired'
    | 'shared'
    | 'released'
    | 'degraded'
    | 'recovered'
    | 'error'
    | 'closed'
    | 'capacity';
  pathClass: WatchPathClass;
  priority: WatchLeasePriority;
  activeDirectoryCount: number;
  leaseCount: number;
  capacity: number;
  reason?: WatchDegradedReason;
  errorCode?: string;
}

export interface WatchBrokerSnapshot {
  capacity: number;
  activeDirectoryCount: number;
  placeholderDirectoryCount: number;
  quarantinedDirectoryCount: number;
  leaseCount: number;
  pendingLeaseCount: number;
  countsByPathClass: Partial<Record<WatchPathClass, number>>;
}

export const CONFIG_WATCH_FORMULA = Object.freeze({
  globalControlDirectoryUpperBound: 3,
  workspaceControlDirectoryUpperBound: 7,
  dynamicDirectoryKinds: ['source', 'skill', 'session'] as const,
});

export interface ConfigWatchBudgetInput {
  workspaceCount: number;
  uniqueGlobalControlDirectories?: number;
  sourceChildDirectories?: number;
  skillChildDirectories?: number;
  sessionChildDirectories?: number;
}

/**
 * Required formula artifact for capacity planning. Irrelevant descendants are
 * deliberately not an input because production observation is non-recursive.
 */
export function calculateConfigWatchBudget(input: ConfigWatchBudgetInput) {
  const uniqueGlobals = Math.min(
    CONFIG_WATCH_FORMULA.globalControlDirectoryUpperBound,
    Math.floor(Math.max(0, input.uniqueGlobalControlDirectories ?? CONFIG_WATCH_FORMULA.globalControlDirectoryUpperBound)),
  );
  const workspaceControls = Math.floor(Math.max(0, input.workspaceCount))
    * CONFIG_WATCH_FORMULA.workspaceControlDirectoryUpperBound;
  const sourceChildren = Math.floor(Math.max(0, input.sourceChildDirectories ?? 0));
  const skillChildren = Math.floor(Math.max(0, input.skillChildDirectories ?? 0));
  const sessionChildren = Math.floor(Math.max(0, input.sessionChildDirectories ?? 0));
  const optionalChildren = sourceChildren + skillChildren + sessionChildren;

  return {
    uniqueGlobals,
    workspaceControls,
    requiredDirectories: uniqueGlobals + workspaceControls,
    optionalChildren,
    totalDirectories: uniqueGlobals + workspaceControls + optionalChildren,
  };
}
