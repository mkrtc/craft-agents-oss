/**
 * Provider-agnostic runtime lifecycle contracts.
 *
 * These types intentionally contain no provider event mapping or lifecycle behavior.
 * Provider adapters translate their native events into these contracts in a later stage.
 */

export const RUNTIME_DISPOSE_OUTCOMES = [
  'graceful',
  'forced',
  'timed_out',
  'no_child',
  'limited_observability',
] as const;

export type RuntimeDisposeOutcome = typeof RUNTIME_DISPOSE_OUTCOMES[number];

export const RUNTIME_DISPOSE_REASONS = [
  'replacement',
  'eviction',
  'shutdown',
  'delete',
  'construction_failed',
  'backend_crash',
  'watchdog',
  'manual',
  'workspace_detach',
] as const;

export type RuntimeDisposeReason = typeof RUNTIME_DISPOSE_REASONS[number];

/**
 * Awaited disposal options. `deadline` is an absolute Unix timestamp in milliseconds;
 * implementations must not interpret it as a relative timeout.
 */
export interface RuntimeDisposeOptions {
  reason: RuntimeDisposeReason;
  deadline?: number;
}

/**
 * Privacy-safe result of an awaited backend disposal attempt.
 * Raw error text and stacks are deliberately excluded.
 */
export interface RuntimeDisposeResult {
  outcome: RuntimeDisposeOutcome;
  observedExit: boolean;
  pid?: number;
  attemptedGraceful: boolean;
  forced: boolean;
  durationMs: number;
  provider?: RuntimeProvider;
  errorCode?: RuntimeErrorCode;
}

export const TERMINAL_DISPOSITIONS = [
  'complete',
  'user_stop',
  'safe_pre_dispatch_auth_retry',
  'post_dispatch_auth_failure',
  'backend_crash',
  'watchdog',
  'handoff',
  'delete',
  'shutdown',
] as const;

export type TerminalDisposition = typeof TERMINAL_DISPOSITIONS[number];

/** Finite machine-readable runtime failures. User-facing text is resolved elsewhere. */
export const RUNTIME_ERROR_CODES = [
  'runtime_capacity_exceeded',
  'runtime_construction_failed',
  'runtime_startup_timeout',
  'runtime_silence_timeout',
  'runtime_tool_timeout',
  'runtime_lease_expired',
  'runtime_permission_expired',
  'runtime_handoff_expired',
  'runtime_backend_crashed',
  'runtime_subprocess_exit',
  'runtime_dispose_failed',
  'runtime_dispose_timed_out',
  'runtime_exit_unobserved',
  'runtime_shutdown',
  'auth_failed_before_dispatch',
  'auth_failed_after_dispatch',
  'steer_undelivered',
] as const;

export type RuntimeErrorCode = typeof RUNTIME_ERROR_CODES[number];

export const RUNTIME_PROVIDERS = ['anthropic', 'pi', 'pi_compat', 'unknown'] as const;
export type RuntimeProvider = typeof RUNTIME_PROVIDERS[number];

/** Immutable identity carried by every internal turn-scoped lifecycle signal. */
export interface RuntimeSignalIdentityV1 {
  runtimeEpoch: number;
  generation: number;
  agentIdentity: string;
  turnToken: string;
}

interface RuntimeLifecycleSignalBaseV1 {
  schemaVersion: 1;
  emittedAt: number;
  identity: RuntimeSignalIdentityV1;
}

export interface RuntimeCompactionSignalV1 extends RuntimeLifecycleSignalBaseV1 {
  type: 'compaction';
  trigger: 'manual' | 'auto' | 'overflow';
  phase: 'start' | 'pending' | 'end' | 'failure';
  errorCode?: RuntimeErrorCode;
}

export interface RuntimeActivitySignalV1 extends RuntimeLifecycleSignalBaseV1 {
  type: 'activity';
  activity: 'backend_heartbeat' | 'assistant_progress' | 'tool_progress';
  toolUseId?: string;
}

export interface RuntimeToolSignalV1 extends RuntimeLifecycleSignalBaseV1 {
  type: 'tool';
  toolUseId: string;
  phase:
    | 'start'
    | 'progress'
    | 'result'
    | 'backgrounded'
    | 'background_progress'
    | 'background_completed'
    | 'background_failed';
  taskId?: string;
  shellId?: string;
  errorCode?: RuntimeErrorCode;
}

export interface RuntimeSubprocessExitSignalV1 extends RuntimeLifecycleSignalBaseV1 {
  type: 'subprocess_exit';
  childIdentity: string;
  pid?: number;
  classification: 'intentional' | 'unexpected';
  exitCode: number | null;
  signal?: 'SIGTERM' | 'SIGKILL' | 'SIGINT' | 'SIGHUP' | 'other';
}

export interface RuntimePermissionSignalV1 extends RuntimeLifecycleSignalBaseV1 {
  type: 'permission';
  permissionToken: string;
  phase: 'enter' | 'resolve' | 'expire';
}

export interface RuntimeHandoffSignalV1 extends RuntimeLifecycleSignalBaseV1 {
  type: 'handoff';
  handoffToken: string;
  handoffKind: 'plan' | 'auth';
  phase: 'enter' | 'resolve' | 'expire';
}

export interface RuntimeProtectedStateSignalV1 extends RuntimeLifecycleSignalBaseV1 {
  type: 'protected_state';
  protectedKind: 'runtime_bound_permission' | 'reconstructible_handoff' | 'background_wait';
  phase: 'enter' | 'resolve' | 'expire';
  /** Absolute Unix timestamp in milliseconds. Protected leases are never activity-renewable. */
  deadline: number;
}

export type RuntimeLifecycleSignalV1 =
  | RuntimeCompactionSignalV1
  | RuntimeActivitySignalV1
  | RuntimeToolSignalV1
  | RuntimeSubprocessExitSignalV1
  | RuntimePermissionSignalV1
  | RuntimeHandoffSignalV1
  | RuntimeProtectedStateSignalV1;

/** Current internal signal schema. Retain the V1 name for persisted/versioned references. */
export type RuntimeLifecycleSignal = RuntimeLifecycleSignalV1;

export const RUNTIME_LIFECYCLE_EVENT_NAMES = [
  'runtime_reserved',
  'runtime_created',
  'runtime_retained',
  'runtime_draining',
  'runtime_disposed',
  'runtime_evicted',
  'runtime_capacity_rejected',
  'turn_started',
  'turn_terminalized',
  'watchdog_timeout',
  'subprocess_exit',
  'outbound_state_changed',
  'handoff_state_changed',
  'protected_state_changed',
  'shutdown_started',
  'shutdown_flushed',
  'shutdown_completed',
  'shutdown_forced',
  'lifecycle_error',
] as const;

export type RuntimeLifecycleEventName = typeof RUNTIME_LIFECYCLE_EVENT_NAMES[number];

export const RUNTIME_LIFECYCLE_REASONS = [
  'create',
  'refresh',
  'auth',
  'delete',
  'branch',
  'shutdown',
  'title',
  'summary',
  'label_skill',
  'connection_test',
  'factory_temporary',
  'idle_ttl',
  'capacity',
  'backend_crash',
  'watchdog',
  'user_stop',
  'handoff',
  'replacement',
  'construction_failed',
  'lease_expired',
  'permission_expired',
  'completed',
  'failed',
] as const;

export type RuntimeLifecycleReason = typeof RUNTIME_LIFECYCLE_REASONS[number];

export const RUNTIME_ERROR_CLASSES = [
  'configuration',
  'capacity',
  'construction',
  'provider',
  'subprocess',
  'timeout',
  'persistence',
  'shutdown',
  'unknown',
] as const;

export type RuntimeErrorClass = typeof RUNTIME_ERROR_CLASSES[number];

/**
 * Finite privacy-safe diagnostic DTO. It contains only bounded scalar fields;
 * prompts, messages, tool payloads, credentials, arbitrary metadata, and raw errors
 * have no representable field.
 */
export interface RuntimeLifecycleEventV1 {
  schemaVersion: 1;
  event: RuntimeLifecycleEventName;
  timestamp: number;
  reason?: RuntimeLifecycleReason;

  ownerKey?: string;
  workspaceKey?: string;
  sessionKey?: string;
  runtimeKey?: string;
  turnKey?: string;
  childKey?: string;

  provider?: RuntimeProvider;
  pid?: number;
  liveCount?: number;
  retainedCount?: number;
  activeCount?: number;
  queuedCount?: number;
  durationMs?: number;
  runtimeEpoch?: number;
  generation?: number;

  disposalOutcome?: RuntimeDisposeOutcome;
  observedExit?: boolean;
  attemptedGraceful?: boolean;
  forced?: boolean;

  errorClass?: RuntimeErrorClass;
  errorCode?: RuntimeErrorCode;
}

/** Current finite diagnostic DTO. Retain the V1 name for version-aware consumers. */
export type RuntimeLifecycleEvent = RuntimeLifecycleEventV1;
