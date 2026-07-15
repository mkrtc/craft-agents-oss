import { describe, expect, it } from 'bun:test';
import type { AgentBackend } from '../backend/index.ts';
import { disposeBackendRuntime } from '../backend/index.ts';
import { TestAgent, createMockBackendConfig } from './test-utils.ts';

describe('AgentBackend awaited disposal compatibility', () => {
  it('adapts legacy dispose/destroy through a truthful limited-observability result', async () => {
    const agent = new TestAgent(createMockBackendConfig());
    let destroyCalls = 0;
    agent.destroy = () => {
      destroyCalls += 1;
    };

    const result = await agent.disposeRuntime({
      reason: 'shutdown',
      deadline: Date.now() + 1_000,
    });

    expect(destroyCalls).toBe(1);
    expect(result).toMatchObject({
      outcome: 'limited_observability',
      observedExit: false,
      attemptedGraceful: false,
      forced: false,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.errorCode).toBeUndefined();
  });

  it('returns a typed code without raw error text when legacy cleanup throws', async () => {
    const agent = new TestAgent(createMockBackendConfig());
    agent.destroy = () => {
      throw new Error('credential-like raw cleanup secret');
    };

    const result = await agent.disposeRuntime({ reason: 'manual' });

    expect(result).toMatchObject({
      outcome: 'limited_observability',
      observedExit: false,
      attemptedGraceful: false,
      forced: false,
      errorCode: 'runtime_dispose_failed',
    });
    expect(JSON.stringify(result)).not.toContain('credential-like raw cleanup secret');
  });

  it('lets legacy structural AgentBackend implementations work through the helper without disposeRuntime', async () => {
    let disposeCalls = 0;
    const legacyBackend = {
      async *chat() {
        yield { type: 'complete' as const };
      },
      async abort() {},
      forceAbort() {},
      interruptForHandoff() {},
      redirect() {
        return false;
      },
      async runMiniCompletion() {
        return null;
      },
      destroy() {
        disposeCalls += 1;
      },
      dispose() {
        disposeCalls += 1;
      },
      async postInit() {
        return { authInjected: true };
      },
      async applyBridgeUpdates() {},
      async ensureBranchReady() {},
      isProcessing() {
        return false;
      },
      getModel() {
        return 'legacy-model';
      },
      setModel() {},
      getThinkingLevel() {
        return 'medium' as const;
      },
      setThinkingLevel() {},
      getPermissionMode() {
        return 'ask' as const;
      },
      setPermissionMode() {},
      cyclePermissionMode() {
        return 'ask' as const;
      },
      getSessionId() {
        return null;
      },
      supportsBranching: false,
      setSourceServers() {},
      getActiveSourceSlugs() {
        return [];
      },
      getCurrentTurnUserMessage() {
        return null;
      },
      setPendingSourceActivationRestart() {},
      getAllSources() {
        return [];
      },
      setAllSources() {},
      markSourceUnseen() {},
      getSummarizeCallback() {
        return async () => null;
      },
      updateWorkingDirectory() {},
      updateSdkCwd() {},
      setWorkspace() {},
      setSessionId() {},
      getSourceManager() {
        return {} as never;
      },
      async generateTitle() {
        return null;
      },
      async regenerateTitle() {
        return null;
      },
      respondToPermission() {},
      onPermissionRequest: null,
      onPlanSubmitted: null,
      onAuthRequest: null,
      onSourceChange: null,
      onPermissionModeChange: null,
      onDebug: null,
      onSourceActivationRequest: null,
      onBackendAuthRequired: null,
      onSpawnSession: null,
    } satisfies AgentBackend;

    const result = await disposeBackendRuntime(legacyBackend, { reason: 'shutdown' });

    expect(disposeCalls).toBe(1);
    expect(result).toMatchObject({
      outcome: 'limited_observability',
      observedExit: false,
      attemptedGraceful: false,
      forced: false,
    });
    expect(result.errorCode).toBeUndefined();
  });
});
