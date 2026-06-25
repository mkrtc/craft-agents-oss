export const CODEX_FAST_MODE_SERVICE_TIER = 'priority';

const CODEX_FAST_MODE_MODEL_IDS = new Set(['gpt-5.5', 'gpt-5.4']);

export interface CodexFastModeModel {
  id?: string;
  provider?: string;
  api?: string;
}

export interface CodexFastModeRequest {
  enabled?: boolean;
  providerType?: string;
  authType?: string;
  authProvider?: string;
  model?: CodexFastModeModel;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeCodexFastModeModelId(modelId: string | undefined): string {
  return (modelId ?? '')
    .replace(/^pi\//, '')
    .replace(/^openai-codex\//, '');
}

export function shouldApplyCodexFastMode(request: CodexFastModeRequest): boolean {
  if (request.enabled !== true) return false;
  if (request.providerType !== 'pi') return false;
  if (request.authType !== 'oauth') return false;
  if (request.authProvider !== 'openai-codex') return false;

  const model = request.model;
  if (model?.provider !== 'openai-codex') return false;
  if (model.api !== 'openai-codex-responses') return false;

  return CODEX_FAST_MODE_MODEL_IDS.has(normalizeCodexFastModeModelId(model.id));
}

export function applyCodexFastModeServiceTier<T>(payload: T, request: CodexFastModeRequest): T {
  if (!isRecord(payload) || !shouldApplyCodexFastMode(request)) return payload;
  return {
    ...payload,
    service_tier: CODEX_FAST_MODE_SERVICE_TIER,
  } as T;
}
