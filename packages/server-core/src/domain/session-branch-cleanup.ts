export interface BranchRollbackManagedSession {
  agent?: { destroy?: () => void } | null
  poolServer?: { stop?: () => void | Promise<void> }
}

interface RollbackParams {
  managed: BranchRollbackManagedSession
  workspaceRootPath: string
  sessionId: string
  deleteFromRuntimeSessions: (sessionId: string) => void
  deleteStoredSession: (workspaceRootPath: string, sessionId: string) => void | boolean | Promise<void | boolean>
  /** Preferred exact awaited bundle owner supplied by SessionManager. */
  disposeRuntime?: () => Promise<void>
}

/**
 * Best-effort rollback when branch creation fails during backend preflight.
 * Ensures no orphan child session remains in memory or persistent storage.
 */
export async function rollbackFailedBranchCreation(params: RollbackParams): Promise<void> {
  const { managed, workspaceRootPath, sessionId, deleteFromRuntimeSessions, deleteStoredSession } = params

  if (params.disposeRuntime) {
    try {
      await params.disposeRuntime()
    } catch {
      // Best-effort rollback continues to remove the failed child session.
    }
  } else {
    // Compatibility fallback for isolated callers/tests. Production SessionManager
    // always supplies the exact awaited bundle owner above.
    try {
      managed.agent?.destroy?.()
    } catch {
      // Best-effort cleanup
    }
    managed.agent = null

    if (managed.poolServer) {
      try {
        await managed.poolServer.stop?.()
      } catch {
        // Best-effort cleanup
      }
      managed.poolServer = undefined
    }
  }

  deleteFromRuntimeSessions(sessionId)

  try {
    await deleteStoredSession(workspaceRootPath, sessionId)
  } catch {
    // Best-effort rollback: runtime cleanup is the critical path.
  }
}
