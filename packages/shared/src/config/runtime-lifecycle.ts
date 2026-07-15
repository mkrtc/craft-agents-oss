/** Pure runtime lifecycle configuration resolution. */

export interface RuntimeLifecycleConfig {
  watchdogEnabled: boolean;
  startupTimeoutMs: number;
  silenceTimeoutMs: number;
  toolTimeoutMs: number;
  protectedLeaseMs: number;
  idleEvictionEnabled: boolean;
  idleTtlMs: number;
  retainedCap: number;
  liveCap: number;
  shutdownTimeoutMs: number;
  flushTimeoutMs: number;
  lifecycleLogEnabled: boolean;
}

export type RuntimeLifecycleEnvironment = Readonly<Record<string, string | undefined>>;

const MAX_TIMER_MS = 2_147_483_647;
const MAX_RUNTIME_CAP = 1_024;

export const DEFAULT_RUNTIME_LIFECYCLE_CONFIG: Readonly<RuntimeLifecycleConfig> = Object.freeze({
  watchdogEnabled: true,
  startupTimeoutMs: 360_000,
  silenceTimeoutMs: 360_000,
  toolTimeoutMs: 1_800_000,
  protectedLeaseMs: 1_800_000,
  idleEvictionEnabled: true,
  idleTtlMs: 600_000,
  retainedCap: 8,
  liveCap: 16,
  shutdownTimeoutMs: 8_000,
  flushTimeoutMs: 3_000,
  lifecycleLogEnabled: true,
});

export const RUNTIME_LIFECYCLE_CONFIG_BOUNDS = Object.freeze({
  startupTimeoutMs: { min: 1, max: MAX_TIMER_MS },
  silenceTimeoutMs: { min: 1, max: MAX_TIMER_MS },
  toolTimeoutMs: { min: 1, max: MAX_TIMER_MS },
  protectedLeaseMs: { min: 1, max: MAX_TIMER_MS },
  idleTtlMs: { min: 1, max: MAX_TIMER_MS },
  retainedCap: { min: 1, max: MAX_RUNTIME_CAP },
  liveCap: { min: 1, max: MAX_RUNTIME_CAP },
  shutdownTimeoutMs: { min: 1, max: MAX_TIMER_MS },
  flushTimeoutMs: { min: 1, max: MAX_TIMER_MS },
});

interface IntegerBounds {
  min: number;
  max: number;
}

/** Only `true`, `false`, `1`, and `0` are accepted (case-insensitive, trimmed). */
function resolveBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return fallback;
}

/**
 * Accepts unsigned decimal integers only. Blank, signed, fractional, exponential,
 * unsafe, zero, and out-of-range values fall back rather than being clamped.
 */
function resolveInteger(
  value: string | undefined,
  fallback: number,
  bounds: IntegerBounds,
): number {
  if (value === undefined) return fallback;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return fallback;

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) return fallback;
  if (parsed < bounds.min || parsed > bounds.max) return fallback;
  return parsed;
}

/**
 * Resolve CRAFT_RUNTIME_* values on every call. The injected environment keeps the
 * helper deterministic in tests and avoids module-import snapshots of kill switches.
 */
export function resolveRuntimeLifecycleConfig(
  env: RuntimeLifecycleEnvironment = process.env,
): RuntimeLifecycleConfig {
  const shutdownTimeoutMs = resolveInteger(
    env.CRAFT_RUNTIME_SHUTDOWN_TIMEOUT_MS,
    DEFAULT_RUNTIME_LIFECYCLE_CONFIG.shutdownTimeoutMs,
    RUNTIME_LIFECYCLE_CONFIG_BOUNDS.shutdownTimeoutMs,
  );
  const requestedFlushTimeoutMs = resolveInteger(
    env.CRAFT_RUNTIME_FLUSH_TIMEOUT_MS,
    DEFAULT_RUNTIME_LIFECYCLE_CONFIG.flushTimeoutMs,
    RUNTIME_LIFECYCLE_CONFIG_BOUNDS.flushTimeoutMs,
  );

  return {
    watchdogEnabled: resolveBoolean(
      env.CRAFT_RUNTIME_WATCHDOG_ENABLED,
      DEFAULT_RUNTIME_LIFECYCLE_CONFIG.watchdogEnabled,
    ),
    startupTimeoutMs: resolveInteger(
      env.CRAFT_RUNTIME_STARTUP_TIMEOUT_MS,
      DEFAULT_RUNTIME_LIFECYCLE_CONFIG.startupTimeoutMs,
      RUNTIME_LIFECYCLE_CONFIG_BOUNDS.startupTimeoutMs,
    ),
    silenceTimeoutMs: resolveInteger(
      env.CRAFT_RUNTIME_SILENCE_TIMEOUT_MS,
      DEFAULT_RUNTIME_LIFECYCLE_CONFIG.silenceTimeoutMs,
      RUNTIME_LIFECYCLE_CONFIG_BOUNDS.silenceTimeoutMs,
    ),
    toolTimeoutMs: resolveInteger(
      env.CRAFT_RUNTIME_TOOL_TIMEOUT_MS,
      DEFAULT_RUNTIME_LIFECYCLE_CONFIG.toolTimeoutMs,
      RUNTIME_LIFECYCLE_CONFIG_BOUNDS.toolTimeoutMs,
    ),
    protectedLeaseMs: resolveInteger(
      env.CRAFT_RUNTIME_PROTECTED_LEASE_MS,
      DEFAULT_RUNTIME_LIFECYCLE_CONFIG.protectedLeaseMs,
      RUNTIME_LIFECYCLE_CONFIG_BOUNDS.protectedLeaseMs,
    ),
    idleEvictionEnabled: resolveBoolean(
      env.CRAFT_RUNTIME_IDLE_EVICTION_ENABLED,
      DEFAULT_RUNTIME_LIFECYCLE_CONFIG.idleEvictionEnabled,
    ),
    idleTtlMs: resolveInteger(
      env.CRAFT_RUNTIME_IDLE_TTL_MS,
      DEFAULT_RUNTIME_LIFECYCLE_CONFIG.idleTtlMs,
      RUNTIME_LIFECYCLE_CONFIG_BOUNDS.idleTtlMs,
    ),
    retainedCap: resolveInteger(
      env.CRAFT_RUNTIME_RETAINED_CAP,
      DEFAULT_RUNTIME_LIFECYCLE_CONFIG.retainedCap,
      RUNTIME_LIFECYCLE_CONFIG_BOUNDS.retainedCap,
    ),
    liveCap: resolveInteger(
      env.CRAFT_RUNTIME_LIVE_CAP,
      DEFAULT_RUNTIME_LIFECYCLE_CONFIG.liveCap,
      RUNTIME_LIFECYCLE_CONFIG_BOUNDS.liveCap,
    ),
    shutdownTimeoutMs,
    // A flush may consume at most the total shutdown budget.
    flushTimeoutMs: Math.min(requestedFlushTimeoutMs, shutdownTimeoutMs),
    lifecycleLogEnabled: resolveBoolean(
      env.CRAFT_RUNTIME_LIFECYCLE_LOG_ENABLED,
      DEFAULT_RUNTIME_LIFECYCLE_CONFIG.lifecycleLogEnabled,
    ),
  };
}
