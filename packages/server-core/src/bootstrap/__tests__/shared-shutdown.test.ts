import { describe, expect, it } from 'bun:test'
import { createSharedShutdown } from '../headless-start.ts'

describe('headless shared shutdown', () => {
  it('returns one in-flight promise to concurrent and repeated stop callers', async () => {
    let runs = 0
    let release!: () => void
    const barrier = new Promise<void>((resolve) => { release = resolve })
    const stop = createSharedShutdown(async () => {
      runs++
      await barrier
    })

    const first = stop()
    const concurrent = stop()
    expect(concurrent).toBe(first)
    expect(runs).toBe(1)

    let settled = false
    void first.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    release()
    await first
    const repeated = stop()
    expect(repeated).toBe(first)
    await repeated
    expect(runs).toBe(1)
  })
})
