import type { SessionFileWatchStatus } from '../../../shared/types'

export interface SessionFileWatchPresentation {
  messageKey: 'chat.sessionFilesWatchPolling' | 'chat.sessionFilesWatchManual'
  toastKey: 'toast.sessionFilesWatchPolling' | 'toast.sessionFilesWatchManual'
  manualRefresh: boolean
}

export function getSessionFileWatchPresentation(
  status: SessionFileWatchStatus | undefined,
): SessionFileWatchPresentation | null {
  if (!status?.degraded) return null
  if (status.mode === 'manual-refresh') {
    return {
      messageKey: 'chat.sessionFilesWatchManual',
      toastKey: 'toast.sessionFilesWatchManual',
      manualRefresh: true,
    }
  }
  return {
    messageKey: 'chat.sessionFilesWatchPolling',
    toastKey: 'toast.sessionFilesWatchPolling',
    manualRefresh: false,
  }
}

export async function restoreSessionFileWatch(
  sessionId: string,
  reloadFiles: () => Promise<void>
): Promise<SessionFileWatchStatus | undefined> {
  let status: SessionFileWatchStatus | undefined
  try {
    status = await window.electronAPI.watchSessionFiles(sessionId)
  } catch (error) {
    console.error(`[SessionFiles] Failed to restore file watch for ${sessionId}:`, error)
  }

  try {
    await reloadFiles()
  } catch (error) {
    console.error(`[SessionFiles] Failed to reload files for ${sessionId} after reconnect:`, error)
  }
  return status
}
