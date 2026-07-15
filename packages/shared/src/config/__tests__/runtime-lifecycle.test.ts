import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_RUNTIME_LIFECYCLE_CONFIG,
  RUNTIME_LIFECYCLE_CONFIG_BOUNDS,
  resolveRuntimeLifecycleConfig,
  type RuntimeLifecycleConfig,
} from '../runtime-lifecycle.ts';

const numericFields: Array<{
  envKey: string;
  configKey: keyof RuntimeLifecycleConfig;
  fallback: number;
  bounds: { min: number; max: number };
}> = [
  {
    envKey: 'CRAFT_RUNTIME_STARTUP_TIMEOUT_MS',
    configKey: 'startupTimeoutMs',
    fallback: DEFAULT_RUNTIME_LIFECYCLE_CONFIG.startupTimeoutMs,
    bounds: RUNTIME_LIFECYCLE_CONFIG_BOUNDS.startupTimeoutMs,
  },
  {
    envKey: 'CRAFT_RUNTIME_SILENCE_TIMEOUT_MS',
    configKey: 'silenceTimeoutMs',
    fallback: DEFAULT_RUNTIME_LIFECYCLE_CONFIG.silenceTimeoutMs,
    bounds: RUNTIME_LIFECYCLE_CONFIG_BOUNDS.silenceTimeoutMs,
  },
  {
    envKey: 'CRAFT_RUNTIME_TOOL_TIMEOUT_MS',
    configKey: 'toolTimeoutMs',
    fallback: DEFAULT_RUNTIME_LIFECYCLE_CONFIG.toolTimeoutMs,
    bounds: RUNTIME_LIFECYCLE_CONFIG_BOUNDS.toolTimeoutMs,
  },
  {
    envKey: 'CRAFT_RUNTIME_PROTECTED_LEASE_MS',
    configKey: 'protectedLeaseMs',
    fallback: DEFAULT_RUNTIME_LIFECYCLE_CONFIG.protectedLeaseMs,
    bounds: RUNTIME_LIFECYCLE_CONFIG_BOUNDS.protectedLeaseMs,
  },
  {
    envKey: 'CRAFT_RUNTIME_IDLE_TTL_MS',
    configKey: 'idleTtlMs',
    fallback: DEFAULT_RUNTIME_LIFECYCLE_CONFIG.idleTtlMs,
    bounds: RUNTIME_LIFECYCLE_CONFIG_BOUNDS.idleTtlMs,
  },
  {
    envKey: 'CRAFT_RUNTIME_RETAINED_CAP',
    configKey: 'retainedCap',
    fallback: DEFAULT_RUNTIME_LIFECYCLE_CONFIG.retainedCap,
    bounds: RUNTIME_LIFECYCLE_CONFIG_BOUNDS.retainedCap,
  },
  {
    envKey: 'CRAFT_RUNTIME_LIVE_CAP',
    configKey: 'liveCap',
    fallback: DEFAULT_RUNTIME_LIFECYCLE_CONFIG.liveCap,
    bounds: RUNTIME_LIFECYCLE_CONFIG_BOUNDS.liveCap,
  },
  {
    envKey: 'CRAFT_RUNTIME_SHUTDOWN_TIMEOUT_MS',
    configKey: 'shutdownTimeoutMs',
    fallback: DEFAULT_RUNTIME_LIFECYCLE_CONFIG.shutdownTimeoutMs,
    bounds: RUNTIME_LIFECYCLE_CONFIG_BOUNDS.shutdownTimeoutMs,
  },
  {
    envKey: 'CRAFT_RUNTIME_FLUSH_TIMEOUT_MS',
    configKey: 'flushTimeoutMs',
    fallback: DEFAULT_RUNTIME_LIFECYCLE_CONFIG.flushTimeoutMs,
    bounds: RUNTIME_LIFECYCLE_CONFIG_BOUNDS.flushTimeoutMs,
  },
];

const booleanFields: Array<{
  envKey: string;
  configKey: keyof RuntimeLifecycleConfig;
  fallback: boolean;
}> = [
  {
    envKey: 'CRAFT_RUNTIME_WATCHDOG_ENABLED',
    configKey: 'watchdogEnabled',
    fallback: DEFAULT_RUNTIME_LIFECYCLE_CONFIG.watchdogEnabled,
  },
  {
    envKey: 'CRAFT_RUNTIME_IDLE_EVICTION_ENABLED',
    configKey: 'idleEvictionEnabled',
    fallback: DEFAULT_RUNTIME_LIFECYCLE_CONFIG.idleEvictionEnabled,
  },
  {
    envKey: 'CRAFT_RUNTIME_LIFECYCLE_LOG_ENABLED',
    configKey: 'lifecycleLogEnabled',
    fallback: DEFAULT_RUNTIME_LIFECYCLE_CONFIG.lifecycleLogEnabled,
  },
];

describe('resolveRuntimeLifecycleConfig', () => {
  it('uses the authoritative defaults', () => {
    expect(resolveRuntimeLifecycleConfig({})).toEqual({
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
  });

  for (const field of booleanFields) {
    for (const [raw, expected] of [
      ['true', true],
      ['TRUE', true],
      ['1', true],
      ['false', false],
      ['FALSE', false],
      ['0', false],
      [' true ', true],
    ] as const) {
      it(`${field.envKey} parses ${JSON.stringify(raw)}`, () => {
        const config = resolveRuntimeLifecycleConfig({ [field.envKey]: raw });
        expect(config[field.configKey]).toBe(expected);
      });
    }

    for (const raw of ['', '   ', 'yes', 'no', '2', '-1']) {
      it(`${field.envKey} falls back for ${JSON.stringify(raw)}`, () => {
        const config = resolveRuntimeLifecycleConfig({ [field.envKey]: raw });
        expect(config[field.configKey]).toBe(field.fallback);
      });
    }
  }

  for (const field of numericFields) {
    it(`${field.envKey} accepts inclusive minimum and maximum bounds`, () => {
      const minConfig = resolveRuntimeLifecycleConfig({ [field.envKey]: String(field.bounds.min) });
      expect(minConfig[field.configKey]).toBe(field.bounds.min);

      const maxEnv: Record<string, string> = { [field.envKey]: String(field.bounds.max) };
      if (field.configKey === 'flushTimeoutMs') {
        maxEnv.CRAFT_RUNTIME_SHUTDOWN_TIMEOUT_MS = String(field.bounds.max);
      }
      const maxConfig = resolveRuntimeLifecycleConfig(maxEnv);
      expect(maxConfig[field.configKey]).toBe(field.bounds.max);
    });

    for (const raw of [
      '',
      '   ',
      'invalid',
      '-1',
      '1.5',
      '1e3',
      '9007199254740992',
      '0',
    ]) {
      it(`${field.envKey} falls back for invalid integer ${JSON.stringify(raw)}`, () => {
        const config = resolveRuntimeLifecycleConfig({ [field.envKey]: raw });
        expect(config[field.configKey]).toBe(field.fallback);
      });
    }

    it(`${field.envKey} falls back above its maximum`, () => {
      const config = resolveRuntimeLifecycleConfig({
        [field.envKey]: String(field.bounds.max + 1),
      });
      expect(config[field.configKey]).toBe(field.fallback);
    });
  }

  it('couples flush timeout to the resolved shutdown budget', () => {
    const config = resolveRuntimeLifecycleConfig({
      CRAFT_RUNTIME_SHUTDOWN_TIMEOUT_MS: '1000',
      CRAFT_RUNTIME_FLUSH_TIMEOUT_MS: '5000',
    });
    expect(config.shutdownTimeoutMs).toBe(1000);
    expect(config.flushTimeoutMs).toBe(1000);
  });

  it('also couples the default flush when a valid shutdown override is smaller', () => {
    const config = resolveRuntimeLifecycleConfig({
      CRAFT_RUNTIME_SHUTDOWN_TIMEOUT_MS: '250',
      CRAFT_RUNTIME_FLUSH_TIMEOUT_MS: 'invalid',
    });
    expect(config.flushTimeoutMs).toBe(250);
  });

  it('re-evaluates independent runtime kill switches on every call', () => {
    const env: Record<string, string> = {
      CRAFT_RUNTIME_WATCHDOG_ENABLED: '0',
      CRAFT_RUNTIME_IDLE_EVICTION_ENABLED: '1',
      CRAFT_RUNTIME_LIFECYCLE_LOG_ENABLED: '0',
    };

    expect(resolveRuntimeLifecycleConfig(env)).toMatchObject({
      watchdogEnabled: false,
      idleEvictionEnabled: true,
      lifecycleLogEnabled: false,
    });

    env.CRAFT_RUNTIME_WATCHDOG_ENABLED = '1';
    env.CRAFT_RUNTIME_IDLE_EVICTION_ENABLED = '0';
    env.CRAFT_RUNTIME_LIFECYCLE_LOG_ENABLED = '1';

    expect(resolveRuntimeLifecycleConfig(env)).toMatchObject({
      watchdogEnabled: true,
      idleEvictionEnabled: false,
      lifecycleLogEnabled: true,
    });
  });
});
