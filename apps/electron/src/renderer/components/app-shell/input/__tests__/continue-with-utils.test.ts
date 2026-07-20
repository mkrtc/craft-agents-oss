import { describe, expect, test } from 'bun:test'
import type { LlmConnectionWithStatus } from '@config/llm-connections'
import { buildContinueWithTargets, getModelId, getModelName } from '../continue-with-utils'

function connection(
  slug: string,
  overrides: Partial<LlmConnectionWithStatus> = {},
): LlmConnectionWithStatus {
  return {
    slug,
    name: slug,
    providerType: 'pi',
    authType: 'oauth',
    isAuthenticated: true,
    models: [`pi/${slug}-model`],
    createdAt: 1,
    ...overrides,
  } as LlmConnectionWithStatus
}

describe('buildContinueWithTargets', () => {
  test('keeps authenticated destinations while excluding the active connection', () => {
    const targets = buildContinueWithTargets([
      connection('codex-1'),
      connection('codex-2'),
      connection('claude', { providerType: 'anthropic' }),
      connection('signed-out', { isAuthenticated: false }),
    ], 'codex-1')

    expect(targets.map(target => target.connection.slug)).toEqual(['codex-2', 'claude'])
  })

  test('drops destinations without an available model', () => {
    const targets = buildContinueWithTargets([
      connection('empty', {
        providerType: 'pi_compat',
        models: [],
        defaultModel: undefined,
      }),
    ])

    expect(targets).toEqual([])
  })

  test('preserves configured model ids and display names', () => {
    const [target] = buildContinueWithTargets([connection('claude', {
      models: ['pi/claude-sonnet'],
    })])

    expect(getModelId(target.models[0])).toBe('pi/claude-sonnet')
    expect(getModelName(target.models[0])).toBe('claude-sonnet')
    expect(getModelName('pi/gpt-5')).toBe('gpt-5')
  })
})
