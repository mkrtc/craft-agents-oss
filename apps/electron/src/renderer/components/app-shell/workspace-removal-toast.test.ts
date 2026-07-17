import { describe, expect, it } from 'bun:test'
import type { WorkspaceRemovalResult } from '../../../shared/types'
import { removeWorkspaceWithToast, workspaceRemovalToastKey } from './workspace-removal-toast'

const cases = [
  ['active-session', 'toast.workspaceRemovalActiveSession'],
  ['active-task', 'toast.workspaceRemovalActiveTask'],
  ['active-background', 'toast.workspaceRemovalActiveBackground'],
  ['required-watch-budget', 'toast.workspaceRemovalRequiredWatchBudget'],
  ['teardown-failed', 'toast.workspaceRemovalTeardownFailed'],
] as const

const workspace = {
  id: 'ws',
  name: 'Workspace',
  slug: 'workspace',
  rootPath: '/workspace',
  createdAt: 1,
}

describe('workspaceRemovalToastKey', () => {
  for (const [code, key] of cases) {
    it(`maps ${code} to an actionable localized toast`, () => {
      expect(workspaceRemovalToastKey({ ok: false, code, retryable: true })).toBe(key)
    })
  }
})

describe('removeWorkspaceWithToast', () => {
  function harness(result: WorkspaceRemovalResult | Error) {
    const messages: Array<[string, string]> = []
    let removed = 0
    return {
      messages,
      get removed() { return removed },
      deps: {
        remove: async () => {
          if (result instanceof Error) throw result
          return result
        },
        translate: (key: string) => key,
        success: (message: string) => { messages.push(['success', message]) },
        error: (message: string) => { messages.push(['error', message]) },
        warning: (message: string) => { messages.push(['warning', message]) },
        onRemoved: () => { removed += 1 },
      },
    }
  }

  it('refreshes workspace state only after a successful typed result', async () => {
    const h = harness({ ok: true, code: 'success' })
    await removeWorkspaceWithToast(workspace, h.deps)
    expect(h.messages).toEqual([['success', 'toast.removedWorkspace']])
    expect(h.removed).toBe(1)
  })

  it('shows refusal without reporting removal', async () => {
    const h = harness({ ok: false, code: 'active-task', retryable: true })
    await removeWorkspaceWithToast(workspace, h.deps)
    expect(h.messages).toEqual([['error', 'toast.workspaceRemovalActiveTask']])
    expect(h.removed).toBe(0)
  })

  it('shows post-detach credential cleanup warning without rolling back UI success', async () => {
    const h = harness({ ok: true, code: 'success', credentialCleanupPending: true })
    await removeWorkspaceWithToast(workspace, h.deps)
    expect(h.messages).toEqual([
      ['success', 'toast.removedWorkspace'],
      ['warning', 'toast.workspaceRemovalCredentialsPending'],
    ])
    expect(h.removed).toBe(1)
  })

  it('turns IPC rejection into a localized failure toast', async () => {
    const h = harness(new Error('ipc failed'))
    await removeWorkspaceWithToast(workspace, h.deps)
    expect(h.messages).toEqual([['error', 'toast.workspaceRemovalFailed']])
    expect(h.removed).toBe(0)
  })
})
