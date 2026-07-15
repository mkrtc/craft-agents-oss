import { describe, expect, it } from 'bun:test'
import { createServerShutdown } from '../shutdown.ts'

async function waitUntil(check: () => boolean, timeoutMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return check()
}

describe('server repeated signal shutdown', () => {
  it('shares one promise and exits only after the first cleanup settles', async () => {
    const calls = { webui: 0, health: 0, messaging: 0, server: 0, exit: 0 }
    let releaseServer!: () => void
    const serverBarrier = new Promise<void>((resolve) => { releaseServer = resolve })
    const shutdown = createServerShutdown({
      disposeWebui: () => { calls.webui++ },
      stopHealth: () => { calls.health++ },
      disposeMessaging: async () => { calls.messaging++ },
      stopServer: async () => {
        calls.server++
        await serverBarrier
      },
      exit: (code) => {
        expect(code).toBe(0)
        calls.exit++
      },
    })

    const sigterm = shutdown()
    const repeatedSigint = shutdown()
    expect(repeatedSigint).toBe(sigterm)
    expect(await waitUntil(() => calls.server === 1)).toBe(true)
    expect(calls.exit).toBe(0)

    releaseServer()
    await sigterm
    expect(calls).toEqual({ webui: 1, health: 1, messaging: 1, server: 1, exit: 1 })

    const afterCompletion = shutdown()
    expect(afterCompletion).toBe(sigterm)
    await afterCompletion
    expect(calls.exit).toBe(1)
  })
})
