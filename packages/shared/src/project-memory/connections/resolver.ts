/**
 * Pure, default-deny resolver helpers for managed Memory space references.
 *
 * This module performs server-side policy checks for session-selected Memory refs:
 * - selected connection must exist,
 * - selected connection must be enabled,
 * - selected space must exist,
 * - selected space must be in scope for the requesting session,
 * - write target must be writable and not global.
 *
 * The resolver is intentionally pure (no network, no process, no secrets).
 * A resolver can optionally receive a callback to fetch credentials; that
 * callback is invoked **only** for allowed connections so denied refs are
 * rejected before any credential/network path.
 */

import type { MemorySpaceKind, MemorySpaceRef } from './types.ts';

export type ManagedMemoryDenyReason =
  | 'connection-not-found'
  | 'connection-disabled'
  | 'space-not-found'
  | 'not-member'
  | 'global-space-write-forbidden'
  | 'space-not-writable';

export interface ManagedMemorySpaceDescriptor {
  spaceId: string;
  kind: MemorySpaceKind;
  writable: boolean;
  workspaceId?: string;
  projectId?: string;
}

export interface ManagedMemoryConnectionDescriptor {
  connectionId: string;
  enabled: boolean;
  spaces: ReadonlyArray<ManagedMemorySpaceDescriptor>;
}

export interface ManagedMemoryResolveContext {
  workspaceId?: string;
  projectId?: string;
}

export interface ManagedMemoryResolveCallbacks {
  /**
   * Optional credential callback (for future integration). Should return an
   * opaque secret marker or throw on failure. Secrets are intentionally never
   * emitted by the resolver outputs.
   */
  loadCredential?: (connectionId: string) => unknown;
}

export interface ManagedMemoryResolvedRef {
  connectionId: string;
  spaceId: string;
  kind: MemorySpaceKind;
  writable: boolean;
}

export interface ManagedMemoryRefDeny {
  code: ManagedMemoryDenyReason;
  ref: MemorySpaceRef;
}

export interface ManagedMemoryResolveResult {
  readRefs: ManagedMemoryResolvedRef[];
  writeRef?: ManagedMemoryResolvedRef;
  deniedRefs: ManagedMemoryRefDeny[];
}

function isMemberOfSpace(
  space: ManagedMemorySpaceDescriptor,
  context: ManagedMemoryResolveContext,
): boolean {
  if (space.kind === 'global') {
    return true;
  }
  if (space.kind === 'workspace') {
    return Boolean(context.workspaceId) && space.workspaceId === context.workspaceId;
  }
  if (space.kind === 'project') {
    return Boolean(context.workspaceId)
      && Boolean(context.projectId)
      && space.workspaceId === context.workspaceId
      && space.projectId === context.projectId;
  }

  // custom
  if (space.workspaceId !== undefined && space.workspaceId !== context.workspaceId) {
    return false;
  }
  if (space.projectId !== undefined && (space.workspaceId !== context.workspaceId || space.projectId !== context.projectId)) {
    return false;
  }
  return true;
}

function findConnection(
  connections: ReadonlyArray<ManagedMemoryConnectionDescriptor>,
  ref: MemorySpaceRef,
): ManagedMemoryConnectionDescriptor | undefined {
  return connections.find(connection => connection.connectionId === ref.connectionId);
}

function findSpace(
  connection: ManagedMemoryConnectionDescriptor,
  ref: MemorySpaceRef,
): ManagedMemorySpaceDescriptor | undefined {
  return connection.spaces.find(space => space.spaceId === ref.spaceId);
}

function fail(code: ManagedMemoryDenyReason, ref: MemorySpaceRef, denied: ManagedMemoryRefDeny[]): void {
  denied.push({ code, ref });
}

/**
 * Resolve read/write permission for session Memory refs.
 *
 * All deny paths are strict by default and skip optional credential callbacks.
 */
export function resolveManagedMemoryRefs(
  connections: ReadonlyArray<ManagedMemoryConnectionDescriptor>,
  refs: { enabledMemorySpaceRefs?: ReadonlyArray<MemorySpaceRef>; memoryWriteTargetRef?: MemorySpaceRef },
  context: ManagedMemoryResolveContext,
  callbacks: ManagedMemoryResolveCallbacks = {},
): ManagedMemoryResolveResult {
  const deniedRefs: ManagedMemoryRefDeny[] = [];
  const readRefs: ManagedMemoryResolvedRef[] = [];
  let writeRef: ManagedMemoryResolvedRef | undefined;

  const usedConnectionIds = new Set<string>();

  const resolveSingle = (ref: MemorySpaceRef, target: 'read' | 'write'): ManagedMemoryResolvedRef | undefined => {
    const connection = findConnection(connections, ref);
    if (!connection) {
      fail('connection-not-found', ref, deniedRefs);
      return undefined;
    }

    if (!connection.enabled) {
      fail('connection-disabled', ref, deniedRefs);
      return undefined;
    }

    const space = findSpace(connection, ref);
    if (!space) {
      fail('space-not-found', ref, deniedRefs);
      return undefined;
    }

    if (!isMemberOfSpace(space, context)) {
      fail('not-member', ref, deniedRefs);
      return undefined;
    }

    if (target === 'write') {
      if (space.kind === 'global') {
        fail('global-space-write-forbidden', ref, deniedRefs);
        return undefined;
      }
      if (!space.writable) {
        fail('space-not-writable', ref, deniedRefs);
        return undefined;
      }
    }

    usedConnectionIds.add(connection.connectionId);

    return {
      connectionId: connection.connectionId,
      spaceId: space.spaceId,
      kind: space.kind,
      writable: space.writable,
    };
  };

  for (const ref of refs.enabledMemorySpaceRefs ?? []) {
    const resolved = resolveSingle(ref, 'read');
    if (resolved) {
      readRefs.push(resolved);
    }
  }

  if (refs.memoryWriteTargetRef) {
    const resolved = resolveSingle(refs.memoryWriteTargetRef, 'write');
    if (resolved) writeRef = resolved;
  }

  // Credential retrieval is intentionally deferred until all denies are known.
  if (callbacks.loadCredential) {
    for (const connectionId of usedConnectionIds) {
      callbacks.loadCredential(connectionId);
    }
  }

  return { readRefs, writeRef, deniedRefs };
}
