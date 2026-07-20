import { describe, expect, test } from 'bun:test'
import type { Session } from '@craft-agent/shared/protocol'
import {
  buildContinuationCreateOptions,
  runContinuationTransaction,
  type ContinuationSourceState,
  type ContinuationTargetState,
} from './session-continuation'

const source: ContinuationSourceState = {
  id: 'source',
  name: 'Existing chat',
  isProcessing: false,
  queuedMessageCount: 0,
  currentConnectionSlug: 'codex-1',
  permissionMode: 'allow-all',
  thinkingLevel: 'high',
  workingDirectory: '/tmp/project',
  labels: ['feature'],
  enabledSourceSlugs: ['github'],
  enabledMemorySpaceRefs: [{ connectionId: 'memory', spaceId: 'project' }],
  memoryWriteTargetRef: { connectionId: 'memory', spaceId: 'project' },
  memorySelectionMode: 'explicit',
  projectId: 'project-1',
}

const target: ContinuationTargetState = {
  slug: 'claude',
  name: 'Claude',
  configuredModelIds: ['claude-sonnet'],
  defaultModel: 'claude-sonnet',
}

const input = { connectionSlug: 'claude', model: 'claude-sonnet' }

function destination(id = 'destination'): Session {
  return {
    id,
    workspaceId: 'workspace',
    workspaceName: 'Workspace',
    messages: [],
    lastMessageAt: 1,
    isProcessing: false,
  } as Session
}

describe('provider continuation transaction', () => {
  test('inherits safe context without mutating source collections', () => {
    const options = buildContinuationCreateOptions(source, input)

    expect(options).toEqual({
      name: 'Existing chat',
      permissionMode: 'allow-all',
      thinkingLevel: 'high',
      workingDirectory: '/tmp/project',
      model: 'claude-sonnet',
      llmConnection: 'claude',
      labels: ['feature'],
      enabledSourceSlugs: ['github'],
      enabledMemorySpaceRefs: [{ connectionId: 'memory', spaceId: 'project' }],
      memoryWriteTargetRef: { connectionId: 'memory', spaceId: 'project' },
      memorySelectionMode: 'explicit',
      projectId: 'project-1',
    })

    options.labels!.push('new')
    options.enabledSourceSlugs!.push('slack')
    options.enabledMemorySpaceRefs![0].spaceId = 'other'
    expect(source.labels).toEqual(['feature'])
    expect(source.enabledSourceSlugs).toEqual(['github'])
    expect(source.enabledMemorySpaceRefs).toEqual([{ connectionId: 'memory', spaceId: 'project' }])
  })

  test('preserves an absent working directory instead of re-resolving workspace defaults', () => {
    const options = buildContinuationCreateOptions({ ...source, workingDirectory: undefined }, input)
    expect(options.workingDirectory).toBe('none')
  })

  test('summarizes before creating and passes a trimmed one-shot handoff', async () => {
    const calls: string[] = []
    let capturedSummary = ''
    const created = destination()

    const result = await runContinuationTransaction(source, target, input, {
      summarize: async () => {
        calls.push('summarize')
        return '  handoff context  '
      },
      create: async (options, summary) => {
        calls.push('create')
        capturedSummary = summary
        expect(options.llmConnection).toBe('claude')
        expect(options.model).toBe('claude-sonnet')
        return created
      },
    })

    expect(calls).toEqual(['summarize', 'create'])
    expect(capturedSummary).toBe('handoff context')
    expect(result).toBe(created)
  })

  test('creates no destination when summary generation fails', async () => {
    let createCount = 0
    await expect(runContinuationTransaction(source, target, input, {
      summarize: async () => null,
      create: async () => {
        createCount++
        return destination()
      },
    })).rejects.toThrow('Could not generate a conversation handoff')
    expect(createCount).toBe(0)
  })

  test('creates no destination when the source changes during summary generation', async () => {
    const calls: string[] = []
    await expect(runContinuationTransaction(source, target, input, {
      summarize: async () => {
        calls.push('summarize')
        return 'summary'
      },
      assertSourceUnchanged: () => {
        calls.push('recheck')
        throw new Error('source changed')
      },
      create: async () => {
        calls.push('create')
        return destination()
      },
    })).rejects.toThrow('source changed')
    expect(calls).toEqual(['summarize', 'recheck'])
  })

  test('refuses processing and queued sources before summary work', async () => {
    for (const blocked of [
      { ...source, isProcessing: true },
      { ...source, queuedMessageCount: 1 },
    ]) {
      let summarizeCount = 0
      await expect(runContinuationTransaction(blocked, target, input, {
        summarize: async () => {
          summarizeCount++
          return 'summary'
        },
        create: async () => destination(),
      })).rejects.toThrow('Wait for the current response')
      expect(summarizeCount).toBe(0)
    }
  })

  test('rejects the current connection and an unconfigured target model', async () => {
    const deps = {
      summarize: async () => 'summary',
      create: async () => destination(),
    }

    await expect(runContinuationTransaction(
      source,
      { ...target, slug: 'codex-1' },
      { connectionSlug: 'codex-1', model: 'claude-sonnet' },
      deps,
    )).rejects.toThrow('Choose a different connection')

    await expect(runContinuationTransaction(
      source,
      target,
      { connectionSlug: 'claude', model: 'unknown' },
      deps,
    )).rejects.toThrow('is not configured')
  })
})
