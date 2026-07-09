type LogLike = {
  info: (message: string, meta?: unknown) => void
}

export interface BeforeQuitEventLike {
  preventDefault: () => void
}

export interface QuitLifecycleDeps {
  isUpdating: () => boolean
  setAppQuitting: () => void
  captureBeforeQuitWindowState: (isUpdateQuit: boolean) => void
  runNormalQuitCleanup: () => Promise<void>
  appQuit: () => void
  mainLog: LogLike
  autoUpdateLog: LogLike
}

/**
 * Coordinates Electron's before-quit lifecycle.
 *
 * Update installs must not cancel the native quitAndInstall() sequence. Normal
 * quits still need one prevented pass so async cleanup can finish, followed by a
 * plain app.quit() re-entry that allows Electron/electron-updater to complete
 * the native quit path (including autoInstallOnAppQuit).
 */
export function createQuitLifecycle(deps: QuitLifecycleDeps) {
  let isQuitting = false
  let isQuitCleanupComplete = false

  async function handleBeforeQuit(event: BeforeQuitEventLike): Promise<void> {
    if (deps.isUpdating()) {
      // quitAndInstall owns the shutdown/install sequence. Do not prevent
      // default, re-call app.quit(), or force app.exit(); just keep synchronous
      // diagnostics and the empty-snapshot guard here.
      deps.setAppQuitting()
      deps.captureBeforeQuitWindowState(true)
      deps.autoUpdateLog.info('Update in progress; allowing electron-updater before-quit to proceed')
      return
    }

    // Re-entry pass after async normal-quit cleanup. Returning without
    // preventing default lets Electron complete a normal quit, preserving
    // autoInstallOnAppQuit.
    if (isQuitting) {
      if (isQuitCleanupComplete) {
        deps.mainLog.info('[quit] cleanup complete; allowing app.quit re-entry to proceed')
        return
      }
      deps.mainLog.info('[quit] cleanup already in progress; preventing duplicate quit')
      event.preventDefault()
      return
    }
    isQuitting = true

    // Prevent only the first normal before-quit pass while async cleanup runs.
    event.preventDefault()

    deps.setAppQuitting()
    deps.captureBeforeQuitWindowState(false)

    try {
      await deps.runNormalQuitCleanup()
    } finally {
      // Continue the normal Electron quit path instead of app.exit(0), which
      // would bypass electron-updater's autoInstallOnAppQuit handling for
      // downloaded updates.
      isQuitCleanupComplete = true
      deps.appQuit()
    }
  }

  return { handleBeforeQuit }
}
