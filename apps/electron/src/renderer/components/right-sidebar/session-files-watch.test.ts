import { describe, expect, it } from 'bun:test'
import type { SessionFileWatchStatus } from '../../../shared/types'
import { getSessionFileWatchPresentation } from './session-files-watch'

function status(mode: SessionFileWatchStatus['mode'], degraded: boolean): SessionFileWatchStatus {
  return {
    mode,
    degraded,
    watchedDirectoryCount: 0,
    limits: { maxEntries: 1, maxDepth: 1, maxDurationMs: 1, maxWatchedDirectories: 1 },
  }
}

describe('getSessionFileWatchPresentation', () => {
  it('keeps healthy watching silent', () => {
    expect(getSessionFileWatchPresentation(status('watching', false))).toBeNull()
  })

  it('presents polling degradation without claiming manual refresh is required', () => {
    expect(getSessionFileWatchPresentation(status('polling', true))).toEqual({
      messageKey: 'chat.sessionFilesWatchPolling',
      toastKey: 'toast.sessionFilesWatchPolling',
      manualRefresh: false,
    })
  })

  it('presents manual-refresh degradation with an actionable refresh state', () => {
    expect(getSessionFileWatchPresentation(status('manual-refresh', true))).toEqual({
      messageKey: 'chat.sessionFilesWatchManual',
      toastKey: 'toast.sessionFilesWatchManual',
      manualRefresh: true,
    })
  })
})
