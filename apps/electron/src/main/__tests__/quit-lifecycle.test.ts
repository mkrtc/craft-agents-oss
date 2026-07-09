import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { createQuitLifecycle, type BeforeQuitEventLike } from '../quit-lifecycle'

function createEvent(): BeforeQuitEventLike & { preventDefault: ReturnType<typeof mock> } {
  return { preventDefault: mock(() => {}) }
}

function createDeferred() {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('createQuitLifecycle', () => {
  let updating = false
  let setAppQuitting: ReturnType<typeof mock>
  let captureBeforeQuitWindowState: ReturnType<typeof mock>
  let runNormalQuitCleanup: ReturnType<typeof mock>
  let appQuit: ReturnType<typeof mock>
  const mainLog = { info: mock(() => {}) }
  const autoUpdateLog = { info: mock(() => {}) }

  beforeEach(() => {
    updating = false
    setAppQuitting = mock(() => {})
    captureBeforeQuitWindowState = mock(() => {})
    runNormalQuitCleanup = mock(async () => {})
    appQuit = mock(() => {})
    mainLog.info.mockClear()
    autoUpdateLog.info.mockClear()
  })

  function lifecycle() {
    return createQuitLifecycle({
      isUpdating: () => updating,
      setAppQuitting,
      captureBeforeQuitWindowState,
      runNormalQuitCleanup,
      appQuit,
      mainLog,
      autoUpdateLog,
    })
  }

  it('lets updater-owned before-quit proceed without preventing default or running cleanup', async () => {
    updating = true
    const event = createEvent()

    await lifecycle().handleBeforeQuit(event)

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(setAppQuitting).toHaveBeenCalledTimes(1)
    expect(captureBeforeQuitWindowState).toHaveBeenCalledWith(true)
    expect(runNormalQuitCleanup).not.toHaveBeenCalled()
    expect(appQuit).not.toHaveBeenCalled()
    expect(autoUpdateLog.info).toHaveBeenCalledWith('Update in progress; allowing electron-updater before-quit to proceed')
  })

  it('prevents the first normal quit, runs cleanup, then calls app.quit for re-entry', async () => {
    const event = createEvent()

    await lifecycle().handleBeforeQuit(event)

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(setAppQuitting).toHaveBeenCalledTimes(1)
    expect(captureBeforeQuitWindowState).toHaveBeenCalledWith(false)
    expect(runNormalQuitCleanup).toHaveBeenCalledTimes(1)
    expect(appQuit).toHaveBeenCalledTimes(1)
  })

  it('prevents duplicate normal quits while cleanup is still running', async () => {
    const deferred = createDeferred()
    runNormalQuitCleanup = mock(() => deferred.promise)
    const q = lifecycle()
    const firstEvent = createEvent()
    const secondEvent = createEvent()

    const firstPass = q.handleBeforeQuit(firstEvent)
    await Promise.resolve()

    await q.handleBeforeQuit(secondEvent)

    expect(firstEvent.preventDefault).toHaveBeenCalledTimes(1)
    expect(secondEvent.preventDefault).toHaveBeenCalledTimes(1)
    expect(appQuit).not.toHaveBeenCalled()

    deferred.resolve()
    await firstPass

    expect(appQuit).toHaveBeenCalledTimes(1)
  })

  it('allows the post-cleanup app.quit re-entry to proceed normally', async () => {
    const q = lifecycle()
    const firstEvent = createEvent()
    const reentryEvent = createEvent()

    await q.handleBeforeQuit(firstEvent)
    await q.handleBeforeQuit(reentryEvent)

    expect(firstEvent.preventDefault).toHaveBeenCalledTimes(1)
    expect(reentryEvent.preventDefault).not.toHaveBeenCalled()
    expect(runNormalQuitCleanup).toHaveBeenCalledTimes(1)
    expect(appQuit).toHaveBeenCalledTimes(1)
  })
})
