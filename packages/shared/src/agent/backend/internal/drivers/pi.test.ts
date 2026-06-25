import { describe, expect, it } from 'bun:test';
import type { LlmConnection } from '../../../../config/llm-connections.ts';
import { piDriver } from './pi.ts';

function buildRuntime(overrides: Partial<LlmConnection>) {
  const connection: LlmConnection = {
    slug: 'chatgpt-plus',
    name: 'ChatGPT Plus',
    providerType: 'pi',
    authType: 'oauth',
    createdAt: Date.now(),
    ...overrides,
  };

  return piDriver.buildRuntime({
    context: {
      provider: 'pi',
      authType: connection.authType,
      resolvedModel: 'gpt-5.5',
      capabilities: { needsHttpPoolServer: false },
      connection,
    },
    coreConfig: {} as never,
    hostRuntime: {} as never,
    resolvedPaths: {
      piServerPath: '/tmp/pi-agent-server.js',
      interceptorBundlePath: '/tmp/interceptor.cjs',
      nodeRuntimePath: '/usr/bin/node',
    },
  });
}

describe('piDriver.buildRuntime Codex Fast Mode', () => {
  it('forwards enabled Codex Fast Mode for ChatGPT Codex OAuth connections', () => {
    const runtime = buildRuntime({
      piAuthProvider: 'openai-codex',
      codexFastMode: true,
    });

    expect(runtime.codexFastMode).toBe(true);
  });

  it('forwards false for eligible connections so live updates can disable it', () => {
    const runtime = buildRuntime({
      piAuthProvider: 'openai-codex',
      codexFastMode: false,
    });

    expect(runtime.codexFastMode).toBe(false);
  });

  it('does not expose Codex Fast Mode for non-Codex Pi auth providers', () => {
    const runtime = buildRuntime({
      piAuthProvider: 'github-copilot',
      codexFastMode: true,
    });

    expect(runtime.codexFastMode).toBeUndefined();
  });
});

describe('piDriver.buildRuntime custom endpoint models', () => {
  it('preserves explicit per-model supportsImages values', () => {
    const runtime = piDriver.buildRuntime({
      context: {
        provider: 'pi',
        authType: 'api_key',
        resolvedModel: 'vision-model',
        capabilities: { needsHttpPoolServer: false },
        connection: {
          slug: 'custom-endpoint',
          name: 'Custom Endpoint',
          providerType: 'pi',
          authType: 'api_key',
          baseUrl: 'http://127.0.0.1:11111/v1',
          customEndpoint: { api: 'anthropic-messages', supportsImages: true },
          models: [
            { id: 'vision-model', contextWindow: 262_144, supportsImages: true },
            { id: 'text-only-model', supportsImages: false },
            { id: 'plain-model' },
          ],
          createdAt: Date.now(),
        } as any,
      },
      coreConfig: {} as any,
      hostRuntime: {} as any,
      resolvedPaths: {
        piServerPath: '/tmp/pi-agent-server.js',
        interceptorBundlePath: '/tmp/interceptor.cjs',
        nodeRuntimePath: '/usr/bin/node',
      },
    });

    expect(runtime.customModels).toEqual([
      { id: 'vision-model', contextWindow: 262_144, supportsImages: true },
      { id: 'text-only-model', supportsImages: false },
      'plain-model',
    ]);
  });
});
