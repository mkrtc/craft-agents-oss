import {
  MemoryConnectionRepository,
  buildEnvironmentMemoryConnection,
  deriveGlobalSpace,
  resolveManagedMemoryRefs,
  type ManagedMemoryConnectionDescriptor,
  type ManagedMemoryResolveCallbacks,
  type ManagedMemoryResolveResult,
  type ManagedMemoryRefDeny,
  type ManagedMemoryResolveContext,
  type ManagedMemorySpaceDescriptor,
  type MemorySpaceRef,
  type MemoryConnectionConfig,
  type GlobalMemorySpaceConfig,
  type StoredMemorySpaceConfig,
} from '@craft-agent/shared/project-memory'

export interface ManagedSessionMemoryContext {
  workspaceId: string
  projectId?: string
  enabledMemorySpaceRefs?: ReadonlyArray<MemorySpaceRef>
  memoryWriteTargetRef?: MemorySpaceRef
}

function shouldIncludeEnvironmentConnection(): boolean {
  return (
    process.env.CRAFT_PROJECT_MEMORY_ENABLED === '0'
    || process.env.CRAFT_QDRANT_URL !== undefined
    || process.env.CRAFT_QDRANT_COLLECTION !== undefined
    || process.env.CRAFT_QDRANT_API_KEY !== undefined
    || process.env.CRAFT_QDRANT_DIMENSION !== undefined
  )
}

function toManagedDescriptorSpace(space: GlobalMemorySpaceConfig | StoredMemorySpaceConfig): ManagedMemorySpaceDescriptor {
  if (space.kind === 'global') {
    return {
      spaceId: space.spaceId,
      kind: space.kind,
      writable: false,
    }
  }

  return {
    spaceId: space.spaceId,
    kind: space.kind,
    writable: space.writable,
    workspaceId: space.workspaceId,
    ...(space.kind === 'project' || space.kind === 'custom' ? { projectId: space.projectId } : {}),
  }
}

function toManagedDescriptor(connection: MemoryConnectionConfig): ManagedMemoryConnectionDescriptor {
  return {
    connectionId: connection.connectionId,
    enabled: connection.enabled,
    spaces: [
      toManagedDescriptorSpace(deriveGlobalSpace(connection)),
      ...connection.spaces.map(toManagedDescriptorSpace),
    ],
  }
}

/**
 * Build the effective connection descriptors used by runtime Memory selection resolution.
 *
 * This includes repository-backed stored connections and (when explicitly configured)
 * the synthetic environment connection derived from `CRAFT_QDRANT_*` variables.
 */
export function loadManagedMemoryConnectionDescriptors(): ManagedMemoryConnectionDescriptor[] {
  const repository = new MemoryConnectionRepository()
  const descriptors: ManagedMemoryConnectionDescriptor[] = repository
    .listConnections()
    .map(toManagedDescriptor)

  if (!shouldIncludeEnvironmentConnection()) {
    return descriptors
  }

  const envConnection = buildEnvironmentMemoryConnection(repository.getInstallationId())
  const envDescriptor = toManagedDescriptor(envConnection)
  if (!descriptors.some(d => d.connectionId === envDescriptor.connectionId)) {
    descriptors.push(envDescriptor)
  }

  return descriptors
}

/**
 * Resolve managed selection against an explicit descriptor list.
 *
 * Returns strict-deny resolution results and never emits secrets.
 */
export function resolveSessionManagedMemorySelection(
  descriptors: ReadonlyArray<ManagedMemoryConnectionDescriptor>,
  context: ManagedSessionMemoryContext,
  callbacks: ManagedMemoryResolveCallbacks = {},
): ManagedMemoryResolveResult {
  const hasExplicitRef = Boolean(context.enabledMemorySpaceRefs?.length) || Boolean(context.memoryWriteTargetRef)
  if (!hasExplicitRef) {
    return {
      readRefs: [],
      writeRef: undefined,
      deniedRefs: [],
    }
  }

  const resolveContext: ManagedMemoryResolveContext = {
    workspaceId: context.workspaceId,
    projectId: context.projectId,
  }

  return resolveManagedMemoryRefs(
    descriptors,
    {
      enabledMemorySpaceRefs: context.enabledMemorySpaceRefs,
      memoryWriteTargetRef: context.memoryWriteTargetRef,
    },
    resolveContext,
    callbacks,
  )
}

/**
 * Resolve managed selection from runtime sources (repository + optional env connection).
 */
export function resolveSessionManagedMemorySelectionFromRepository(
  context: ManagedSessionMemoryContext,
  callbacks: ManagedMemoryResolveCallbacks = {},
): ManagedMemoryResolveResult {
  return resolveSessionManagedMemorySelection(
    loadManagedMemoryConnectionDescriptors(),
    context,
    callbacks,
  )
}

export function formatSessionMemorySelectionDeniedReason(
  denied: ManagedMemoryRefDeny,
): string {
  return `${denied.code}(${denied.ref.connectionId}/${denied.ref.spaceId})`
}
