export interface PreUpdateCleanupLog {
  warn: (message: string, meta?: unknown) => void
}

export interface PreUpdateCleanupDeps<TCancellation = unknown> {
  captureWindowState: () => void
  flushRecoverableState: () => Promise<void>
  enterTerminalShutdown: () => void
  cancelActiveTurns: () => Promise<TCancellation>
  cleanupRuntimes: () => Promise<void>
  log: PreUpdateCleanupLog
}

/**
 * Coordinates the recoverable and terminal phases before electron-updater owns
 * the native quit. Errors before `enterTerminalShutdown` abort the install and
 * leave chats usable. Once admission closes, cleanup is fail-closed: bounded
 * teardown errors are logged and the updater handoff must continue.
 */
export async function runPreUpdateCleanup<TCancellation>(
  deps: PreUpdateCleanupDeps<TCancellation>,
): Promise<TCancellation | undefined> {
  deps.captureWindowState()
  await deps.flushRecoverableState()

  deps.enterTerminalShutdown()

  let cancellation: TCancellation | undefined
  try {
    cancellation = await deps.cancelActiveTurns()
  } catch (error) {
    deps.log.warn('Active-turn cancellation failed during terminal update shutdown', error)
  }

  try {
    await deps.cleanupRuntimes()
  } catch (error) {
    deps.log.warn('Runtime cleanup failed during terminal update shutdown', error)
  }

  return cancellation
}
