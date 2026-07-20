import type {
  ContinueSessionInput,
  CreateSessionOptions,
  Session,
} from '@craft-agent/shared/protocol'

export interface ContinuationSourceState {
  id: string
  name?: string
  isProcessing: boolean
  queuedMessageCount: number
  currentConnectionSlug?: string
  permissionMode?: CreateSessionOptions['permissionMode']
  thinkingLevel?: CreateSessionOptions['thinkingLevel']
  workingDirectory?: CreateSessionOptions['workingDirectory']
  labels?: string[]
  enabledSourceSlugs?: string[]
  enabledMemorySpaceRefs?: CreateSessionOptions['enabledMemorySpaceRefs']
  memoryWriteTargetRef?: CreateSessionOptions['memoryWriteTargetRef']
  memorySelectionMode?: CreateSessionOptions['memorySelectionMode']
  projectId?: string
}

export interface ContinuationTargetState {
  slug: string
  name: string
  configuredModelIds: string[]
  defaultModel?: string
}

export interface ContinuationTransactionDeps {
  summarize: () => Promise<string | null>
  assertSourceUnchanged?: () => void | Promise<void>
  create: (options: CreateSessionOptions, summary: string) => Promise<Session>
}

export function buildContinuationCreateOptions(
  source: ContinuationSourceState,
  input: ContinueSessionInput,
): CreateSessionOptions {
  return {
    name: source.name,
    permissionMode: source.permissionMode,
    thinkingLevel: source.thinkingLevel,
    // Managed sessions store the resolved path; undefined therefore means the
    // source truly has no working directory, not "re-resolve today's default".
    workingDirectory: source.workingDirectory ?? 'none',
    model: input.model,
    llmConnection: input.connectionSlug,
    labels: source.labels ? [...source.labels] : undefined,
    enabledSourceSlugs: source.enabledSourceSlugs ? [...source.enabledSourceSlugs] : undefined,
    enabledMemorySpaceRefs: source.enabledMemorySpaceRefs?.map(ref => ({ ...ref })),
    memoryWriteTargetRef: source.memoryWriteTargetRef ? { ...source.memoryWriteTargetRef } : undefined,
    memorySelectionMode: source.memorySelectionMode,
    projectId: source.projectId,
  }
}

export async function runContinuationTransaction(
  source: ContinuationSourceState,
  target: ContinuationTargetState,
  input: ContinueSessionInput,
  deps: ContinuationTransactionDeps,
): Promise<Session> {
  const connectionSlug = input?.connectionSlug?.trim()
  const model = input?.model?.trim()
  if (!connectionSlug) throw new Error('A destination connection is required')
  if (!model) throw new Error('A destination model is required')
  if (source.isProcessing || source.queuedMessageCount > 0) {
    throw new Error('Wait for the current response to finish or stop it before continuing with another provider.')
  }
  if (source.currentConnectionSlug === connectionSlug) {
    throw new Error('Choose a different connection. Models on the current connection can be changed in place.')
  }
  if (target.slug !== connectionSlug) throw new Error('Destination connection mismatch')
  if (
    target.configuredModelIds.length > 0 &&
    !target.configuredModelIds.includes(model) &&
    target.defaultModel !== model
  ) {
    throw new Error(`Model "${model}" is not configured for connection "${target.name}"`)
  }

  const normalizedInput = { connectionSlug, model }
  const summary = await deps.summarize()
  if (!summary?.trim()) throw new Error('Could not generate a conversation handoff for this session')
  await deps.assertSourceUnchanged?.()

  return deps.create(buildContinuationCreateOptions(source, normalizedInput), summary.trim())
}
