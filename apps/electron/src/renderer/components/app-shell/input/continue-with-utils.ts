import type { LlmConnectionWithStatus } from '@config/llm-connections'
import { getDefaultModelsForConnection } from '@config/llm-connections'
import type { ModelDefinition } from '@config/models'

export interface ContinueWithTarget {
  connection: LlmConnectionWithStatus
  models: Array<ModelDefinition | string>
}

export function buildContinueWithTargets(
  connections: readonly LlmConnectionWithStatus[],
  currentConnectionSlug?: string,
): ContinueWithTarget[] {
  return connections
    .filter(connection => connection.isAuthenticated && connection.slug !== currentConnectionSlug)
    .map(connection => ({
      connection,
      models: connection.models?.length
        ? [...connection.models]
        : getDefaultModelsForConnection(connection.providerType, connection.piAuthProvider),
    }))
    .filter(target => target.models.length > 0)
}

export function getModelId(model: ModelDefinition | string): string {
  return typeof model === 'string' ? model : model.id
}

export function getModelName(model: ModelDefinition | string): string {
  if (typeof model === 'string') return model.startsWith('pi/') ? model.slice(3) : model
  return model.name ?? (model.id.startsWith('pi/') ? model.id.slice(3) : model.id)
}
