import type { Workspace, WorkspaceRemovalResult } from '../../../shared/types'

export type WorkspaceRemovalToastKey =
  | 'toast.workspaceRemovalActiveSession'
  | 'toast.workspaceRemovalActiveTask'
  | 'toast.workspaceRemovalActiveBackground'
  | 'toast.workspaceRemovalTeardownFailed'
  | 'toast.workspaceRemovalRequiredWatchBudget'
  | 'toast.workspaceRemovalFailed'

export function workspaceRemovalToastKey(
  result: Extract<WorkspaceRemovalResult, { ok: false }>,
): Exclude<WorkspaceRemovalToastKey, 'toast.workspaceRemovalFailed'> {
  switch (result.code) {
    case 'active-session': return 'toast.workspaceRemovalActiveSession'
    case 'active-task': return 'toast.workspaceRemovalActiveTask'
    case 'active-background': return 'toast.workspaceRemovalActiveBackground'
    case 'required-watch-budget': return 'toast.workspaceRemovalRequiredWatchBudget'
    case 'teardown-failed': return 'toast.workspaceRemovalTeardownFailed'
  }
}

interface WorkspaceRemovalToastDeps {
  remove: (workspaceId: string) => Promise<WorkspaceRemovalResult>
  translate: (key: string, options?: Record<string, unknown>) => string
  success: (message: string) => void
  error: (message: string) => void
  warning: (message: string) => void
  onRemoved?: () => void
}

/** Shared UI outcome handling used by both desktop and compact switchers. */
export async function removeWorkspaceWithToast(
  workspace: Workspace,
  deps: WorkspaceRemovalToastDeps,
): Promise<void> {
  try {
    const result = await deps.remove(workspace.id)
    if (!result.ok) {
      deps.error(deps.translate(workspaceRemovalToastKey(result)))
      return
    }
    deps.success(deps.translate('toast.removedWorkspace', { name: workspace.name }))
    if (result.credentialCleanupPending) {
      deps.warning(deps.translate('toast.workspaceRemovalCredentialsPending'))
    }
    deps.onRemoved?.()
  } catch {
    deps.error(deps.translate('toast.workspaceRemovalFailed'))
  }
}
