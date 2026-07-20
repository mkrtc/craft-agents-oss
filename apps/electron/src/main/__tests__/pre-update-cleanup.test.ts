import { describe, expect, it, mock } from 'bun:test'
import { runPreUpdateCleanup } from '../pre-update-cleanup'

function deps(order: string[]) {
  return {
    captureWindowState: mock(() => { order.push('snapshot') }),
    flushRecoverableState: mock(async () => { order.push('preflight-flush') }),
    enterTerminalShutdown: mock(() => { order.push('close-admission') }),
    cancelActiveTurns: mock(async () => {
      order.push('cancel-active')
      return { targeted: 2, cancelled: 2, forced: 0, failures: [] }
    }),
    cleanupRuntimes: mock(async () => { order.push('runtime-cleanup') }),
    log: { warn: mock(() => {}) },
  }
}

describe('runPreUpdateCleanup', () => {
  it('enforces snapshot → preflight → cancellation → cleanup ordering', async () => {
    const order: string[] = []
    const d = deps(order)

    const result = await runPreUpdateCleanup(d)

    expect(order).toEqual([
      'snapshot',
      'preflight-flush',
      'close-admission',
      'cancel-active',
      'runtime-cleanup',
    ])
    expect(result).toEqual({ targeted: 2, cancelled: 2, forced: 0, failures: [] })
  })

  it('does not close admission or cancel chats when recoverable preflight fails', async () => {
    const order: string[] = []
    const d = deps(order)
    d.flushRecoverableState = mock(async () => {
      order.push('preflight-flush')
      throw new Error('flush failed')
    })

    await expect(runPreUpdateCleanup(d)).rejects.toThrow('flush failed')

    expect(order).toEqual(['snapshot', 'preflight-flush'])
    expect(d.enterTerminalShutdown).not.toHaveBeenCalled()
    expect(d.cancelActiveTurns).not.toHaveBeenCalled()
    expect(d.cleanupRuntimes).not.toHaveBeenCalled()
  })

  it('continues bounded terminal cleanup after cancellation failure', async () => {
    const order: string[] = []
    const d = deps(order)
    d.cancelActiveTurns = mock(async () => {
      order.push('cancel-active')
      throw new Error('provider stuck')
    })

    await expect(runPreUpdateCleanup(d)).resolves.toBeUndefined()

    expect(order).toEqual([
      'snapshot',
      'preflight-flush',
      'close-admission',
      'cancel-active',
      'runtime-cleanup',
    ])
    expect(d.log.warn).toHaveBeenCalledTimes(1)
  })

  it('does not strand terminal shutdown when runtime cleanup reports an error', async () => {
    const order: string[] = []
    const d = deps(order)
    d.cleanupRuntimes = mock(async () => {
      order.push('runtime-cleanup')
      throw new Error('cleanup failed')
    })

    await expect(runPreUpdateCleanup(d)).resolves.toEqual({
      targeted: 2,
      cancelled: 2,
      forced: 0,
      failures: [],
    })
    expect(d.log.warn).toHaveBeenCalledTimes(1)
  })
})
