import { describe, expect, it } from 'bun:test';
import {
  CODEX_FAST_MODE_SERVICE_TIER,
  applyCodexFastModeServiceTier,
  normalizeCodexFastModeModelId,
  shouldApplyCodexFastMode,
} from './codex-fast-mode.ts';

const baseRequest = {
  enabled: true,
  providerType: 'pi',
  authType: 'oauth',
  authProvider: 'openai-codex',
  model: {
    id: 'gpt-5.5',
    provider: 'openai-codex',
    api: 'openai-codex-responses',
  },
};

describe('codex fast mode policy', () => {
  it('normalizes Pi/Codex model prefixes', () => {
    expect(normalizeCodexFastModeModelId('pi/gpt-5.5')).toBe('gpt-5.5');
    expect(normalizeCodexFastModeModelId('openai-codex/gpt-5.4')).toBe('gpt-5.4');
  });

  it('enables priority service tier for supported ChatGPT Codex models', () => {
    expect(shouldApplyCodexFastMode(baseRequest)).toBe(true);

    const payload = applyCodexFastModeServiceTier({ model: 'gpt-5.5' }, baseRequest);
    expect(payload).toEqual({
      model: 'gpt-5.5',
      service_tier: CODEX_FAST_MODE_SERVICE_TIER,
    });
  });

  it('allows GPT-5.4 and rejects GPT-5.4 mini', () => {
    expect(shouldApplyCodexFastMode({
      ...baseRequest,
      model: { ...baseRequest.model, id: 'gpt-5.4' },
    })).toBe(true);

    expect(shouldApplyCodexFastMode({
      ...baseRequest,
      model: { ...baseRequest.model, id: 'gpt-5.4-mini' },
    })).toBe(false);
  });

  it('does not apply outside ChatGPT Codex OAuth', () => {
    expect(shouldApplyCodexFastMode({
      ...baseRequest,
      authType: 'api_key',
    })).toBe(false);

    expect(shouldApplyCodexFastMode({
      ...baseRequest,
      authProvider: 'openai',
      model: { ...baseRequest.model, provider: 'openai' },
    })).toBe(false);
  });

  it('leaves payload untouched when the policy does not match', () => {
    const payload = { model: 'gpt-5.5' };
    expect(applyCodexFastModeServiceTier(payload, {
      ...baseRequest,
      enabled: false,
    })).toBe(payload);
  });
});
