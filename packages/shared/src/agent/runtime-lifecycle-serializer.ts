import {
  RUNTIME_DISPOSE_OUTCOMES,
  RUNTIME_ERROR_CLASSES,
  RUNTIME_ERROR_CODES,
  RUNTIME_LIFECYCLE_EVENT_NAMES,
  RUNTIME_LIFECYCLE_REASONS,
  RUNTIME_PROVIDERS,
  type RuntimeLifecycleEventV1,
} from '@craft-agent/core/types';

export const RUNTIME_LIFECYCLE_CORRELATION_MAX_CHARS = 128;
export const RUNTIME_LIFECYCLE_EVENT_MAX_BYTES = 4_096;

const MAX_COUNT = 1_000_000;
const MAX_TIMER_MS = 2_147_483_647;
const MAX_PID = 2_147_483_647;
const SAFE_INTEGER_MAX = Number.MAX_SAFE_INTEGER;

const EVENT_NAMES = new Set<string>(RUNTIME_LIFECYCLE_EVENT_NAMES);
const REASONS = new Set<string>(RUNTIME_LIFECYCLE_REASONS);
const PROVIDERS = new Set<string>(RUNTIME_PROVIDERS);
const DISPOSE_OUTCOMES = new Set<string>(RUNTIME_DISPOSE_OUTCOMES);
const ERROR_CLASSES = new Set<string>(RUNTIME_ERROR_CLASSES);
const ERROR_CODES = new Set<string>(RUNTIME_ERROR_CODES);
const SAFE_CORRELATION = /^[A-Za-z0-9._:-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function finiteInteger(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return undefined;
  if (value < min || value > max) return undefined;
  return value;
}

function finiteBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function allowlistedString(value: unknown, values: ReadonlySet<string>): string | undefined {
  return typeof value === 'string' && values.has(value) ? value : undefined;
}

function correlationKey(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || !SAFE_CORRELATION.test(value)) {
    return undefined;
  }
  return value.slice(0, RUNTIME_LIFECYCLE_CORRELATION_MAX_CHARS);
}

/**
 * Convert unknown input to the finite diagnostic DTO by selecting every field
 * explicitly. Nested values and unrecognized fields are never traversed.
 */
export function toRuntimeLifecycleEvent(input: unknown): RuntimeLifecycleEventV1 | null {
  if (!isRecord(input) || input.schemaVersion !== 1) return null;

  const event = allowlistedString(input.event, EVENT_NAMES);
  const timestamp = finiteInteger(input.timestamp, 0, SAFE_INTEGER_MAX);
  if (!event || timestamp === undefined) return null;

  const output: RuntimeLifecycleEventV1 = {
    schemaVersion: 1,
    event: event as RuntimeLifecycleEventV1['event'],
    timestamp,
  };

  const reason = allowlistedString(input.reason, REASONS);
  if (reason !== undefined) output.reason = reason as NonNullable<RuntimeLifecycleEventV1['reason']>;

  const ownerKey = correlationKey(input.ownerKey);
  if (ownerKey !== undefined) output.ownerKey = ownerKey;
  const workspaceKey = correlationKey(input.workspaceKey);
  if (workspaceKey !== undefined) output.workspaceKey = workspaceKey;
  const sessionKey = correlationKey(input.sessionKey);
  if (sessionKey !== undefined) output.sessionKey = sessionKey;
  const runtimeKey = correlationKey(input.runtimeKey);
  if (runtimeKey !== undefined) output.runtimeKey = runtimeKey;
  const turnKey = correlationKey(input.turnKey);
  if (turnKey !== undefined) output.turnKey = turnKey;
  const childKey = correlationKey(input.childKey);
  if (childKey !== undefined) output.childKey = childKey;

  const provider = allowlistedString(input.provider, PROVIDERS);
  if (provider !== undefined) output.provider = provider as NonNullable<RuntimeLifecycleEventV1['provider']>;

  const pid = finiteInteger(input.pid, 1, MAX_PID);
  if (pid !== undefined) output.pid = pid;
  const liveCount = finiteInteger(input.liveCount, 0, MAX_COUNT);
  if (liveCount !== undefined) output.liveCount = liveCount;
  const retainedCount = finiteInteger(input.retainedCount, 0, MAX_COUNT);
  if (retainedCount !== undefined) output.retainedCount = retainedCount;
  const activeCount = finiteInteger(input.activeCount, 0, MAX_COUNT);
  if (activeCount !== undefined) output.activeCount = activeCount;
  const queuedCount = finiteInteger(input.queuedCount, 0, MAX_COUNT);
  if (queuedCount !== undefined) output.queuedCount = queuedCount;
  const durationMs = finiteInteger(input.durationMs, 0, MAX_TIMER_MS);
  if (durationMs !== undefined) output.durationMs = durationMs;
  const runtimeEpoch = finiteInteger(input.runtimeEpoch, 0, SAFE_INTEGER_MAX);
  if (runtimeEpoch !== undefined) output.runtimeEpoch = runtimeEpoch;
  const generation = finiteInteger(input.generation, 0, SAFE_INTEGER_MAX);
  if (generation !== undefined) output.generation = generation;

  const disposalOutcome = allowlistedString(input.disposalOutcome, DISPOSE_OUTCOMES);
  if (disposalOutcome !== undefined) {
    output.disposalOutcome = disposalOutcome as NonNullable<RuntimeLifecycleEventV1['disposalOutcome']>;
  }
  const observedExit = finiteBoolean(input.observedExit);
  if (observedExit !== undefined) output.observedExit = observedExit;
  const attemptedGraceful = finiteBoolean(input.attemptedGraceful);
  if (attemptedGraceful !== undefined) output.attemptedGraceful = attemptedGraceful;
  const forced = finiteBoolean(input.forced);
  if (forced !== undefined) output.forced = forced;

  const errorClass = allowlistedString(input.errorClass, ERROR_CLASSES);
  if (errorClass !== undefined) {
    output.errorClass = errorClass as NonNullable<RuntimeLifecycleEventV1['errorClass']>;
  }
  const errorCode = allowlistedString(input.errorCode, ERROR_CODES);
  if (errorCode !== undefined) output.errorCode = errorCode as NonNullable<RuntimeLifecycleEventV1['errorCode']>;

  return output;
}

/** Serialize one bounded JSON line, or return null for an invalid/oversized event. */
export function serializeRuntimeLifecycleEvent(input: unknown): string | null {
  const event = toRuntimeLifecycleEvent(input);
  if (!event) return null;

  const serialized = JSON.stringify(event);
  if (new TextEncoder().encode(serialized).byteLength > RUNTIME_LIFECYCLE_EVENT_MAX_BYTES) {
    return null;
  }
  return serialized;
}
