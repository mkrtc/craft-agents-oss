/**
 * Focused tests for the main-process auto-update install handoff.
 *
 * The macOS updater bug was caused by app-level quit cleanup cancelling the
 * quitAndInstall() lifecycle. These tests lock down the critical pre-handoff
 * behavior: async cleanup must complete before electron-updater owns quit, and
 * failed cleanup must abort rather than silently skipping pending session flushes.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'

const listeners = new Map<string, Array<(...args: any[]) => unknown>>()

let quitAndInstallImpl: (isSilent?: boolean, isForceRunAfter?: boolean) => void = () => {}
const quitAndInstall = mock((isSilent?: boolean, isForceRunAfter?: boolean) => {
  quitAndInstallImpl(isSilent, isForceRunAfter)
})
let downloadUpdateImpl: () => Promise<unknown> = async () => []
const downloadUpdate = mock(async () => downloadUpdateImpl())
const clearDismissedUpdateVersion = mock(() => {})
const getAllWindows = mock(() => [])

const autoUpdater: any = {
  autoDownload: false,
  autoInstallOnAppQuit: false,
  logger: null,
  downloadedUpdateHelper: null,
  on: mock((event: string, cb: (...args: any[]) => unknown) => {
    const existing = listeners.get(event) ?? []
    existing.push(cb)
    listeners.set(event, existing)
  }),
  checkForUpdates: mock(async () => ({ updateInfo: { version: '0.11.4' } })),
  downloadUpdate,
  quitAndInstall,
}

mock.module('electron-updater', () => ({ autoUpdater }))

mock.module('electron', () => ({
  app: {
    getName: () => 'Craft Agents',
    getPath: (name: string) => name === 'home' ? '/tmp/craft-home' : `/tmp/craft-${name}`,
  },
  BrowserWindow: {
    getAllWindows,
  },
}))

mock.module('@craft-agent/shared/version', () => ({
  getAppVersion: () => '0.11.3',
}))

mock.module('@craft-agent/shared/config', () => ({
  getDismissedUpdateVersion: () => null,
  clearDismissedUpdateVersion,
}))

mock.module('@craft-agent/shared/utils/files', () => ({
  readJsonFileSync: () => null,
}))

mock.module('../logger', () => {
  const stubLog = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
  return {
    mainLog: stubLog,
    autoUpdateLog: stubLog,
  }
})

mock.module('../menu', () => ({
  rebuildMenu: mock(() => {}),
}))

const autoUpdate = await import('../auto-update')

async function emit(event: string, ...args: any[]): Promise<void> {
  for (const listener of listeners.get(event) ?? []) {
    await listener(...args)
  }
}

async function markUpdateReady(version = '0.11.4'): Promise<void> {
  autoUpdater.downloadedUpdateHelper = {
    cacheDir: '/tmp/craft-updater-cache',
    versionInfo: { version },
  }
  await emit('update-available', { version })
}

beforeEach(() => {
  quitAndInstall.mockClear()
  downloadUpdate.mockClear()
  clearDismissedUpdateVersion.mockClear()
  getAllWindows.mockClear()
  autoUpdater.downloadedUpdateHelper = null
  quitAndInstallImpl = () => {}
  downloadUpdateImpl = async () => []
})

describe('installUpdate', () => {
  it('aborts deterministically when the async pre-update hook fails', async () => {
    await markUpdateReady('0.11.4')

    const hookError = new Error('flush failed')
    const hook = mock(async () => {
      throw hookError
    })
    autoUpdate.setBeforeUpdateQuitHook(hook)

    await expect(autoUpdate.installUpdate()).rejects.toThrow('flush failed')

    expect(hook).toHaveBeenCalledTimes(1)
    expect(quitAndInstall).not.toHaveBeenCalled()
    expect(clearDismissedUpdateVersion).not.toHaveBeenCalled()
    expect(autoUpdate.isUpdating()).toBe(false)
    expect(autoUpdate.getUpdateInfo()).toMatchObject({
      downloadState: 'error',
      error: 'Pre-update cleanup failed: flush failed',
    })
  })

  it('re-drives download when UI is ready but electron-updater has no validated helper', async () => {
    await emit('update-downloaded', { version: '0.11.5' })

    const hook = mock(async () => {})
    autoUpdate.setBeforeUpdateQuitHook(hook)
    downloadUpdateImpl = async () => {
      autoUpdater.downloadedUpdateHelper = {
        cacheDir: '/tmp/craft-updater-cache',
        versionInfo: { version: '0.11.5' },
      }
      return []
    }

    await autoUpdate.installUpdate()

    expect(downloadUpdate).toHaveBeenCalledTimes(1)
    expect(hook).toHaveBeenCalledTimes(1)
    expect(quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('reports an installable-state error instead of calling quitAndInstall when re-download fails', async () => {
    await emit('update-downloaded', { version: '0.11.5' })

    const hook = mock(async () => {})
    autoUpdate.setBeforeUpdateQuitHook(hook)
    downloadUpdateImpl = async () => {
      throw new Error('network unavailable')
    }

    await expect(autoUpdate.installUpdate()).rejects.toThrow('re-download failed: network unavailable')

    expect(downloadUpdate).toHaveBeenCalledTimes(1)
    expect(hook).not.toHaveBeenCalled()
    expect(quitAndInstall).not.toHaveBeenCalled()
    expect(autoUpdate.isUpdating()).toBe(false)
    expect(autoUpdate.getUpdateInfo()).toMatchObject({
      downloadState: 'error',
      error: 'Downloaded update is not ready to install and re-download failed: network unavailable',
    })
  })

  it('awaits async pre-update cleanup before quitAndInstall and clears dismissal only after cleanup', async () => {
    await markUpdateReady('0.11.5')

    const order: string[] = []
    let resolveHook!: () => void
    const hook = mock(() => new Promise<void>((resolve) => {
      order.push('hook-start')
      resolveHook = () => {
        order.push('hook-finish')
        resolve()
      }
    }))
    quitAndInstallImpl = () => {
      order.push('quit-and-install')
    }
    autoUpdate.setBeforeUpdateQuitHook(hook)

    const installPromise = autoUpdate.installUpdate()
    await Promise.resolve()

    expect(hook).toHaveBeenCalledTimes(1)
    expect(quitAndInstall).not.toHaveBeenCalled()
    expect(clearDismissedUpdateVersion).not.toHaveBeenCalled()

    resolveHook()
    await installPromise

    expect(order).toEqual(['hook-start', 'hook-finish', 'quit-and-install'])
    expect(clearDismissedUpdateVersion).toHaveBeenCalledTimes(1)
    expect(quitAndInstall).toHaveBeenCalledWith(false, true)
    expect(autoUpdate.isUpdating()).toBe(true)
  })
})
