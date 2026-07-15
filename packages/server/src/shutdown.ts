import { createSharedShutdown } from '@craft-agent/server-core/bootstrap'

export interface ServerShutdownSteps {
  disposeWebui?: () => Promise<void> | void
  stopHealth?: () => Promise<void> | void
  disposeMessaging?: () => Promise<void> | void
  stopServer: () => Promise<void>
  exit: (code: number) => void
  logError?: (message: string, error: unknown) => void
}

/**
 * Creates the one shutdown callback shared by SIGINT and SIGTERM.
 * Repeated signals receive the exact same promise and cannot exit the process
 * ahead of the first signal's bounded bootstrap cleanup.
 */
export function createServerShutdown(steps: ServerShutdownSteps): () => Promise<void> {
  const runStep = async (name: string, step: (() => Promise<void> | void) | undefined) => {
    if (!step) return
    try {
      await step()
    } catch (error) {
      steps.logError?.(`[shutdown] ${name} failed`, error)
    }
  }

  return createSharedShutdown(async () => {
    await runStep('web UI dispose', steps.disposeWebui)
    await runStep('health server stop', steps.stopHealth)
    await runStep('messaging dispose', steps.disposeMessaging)
    await runStep('server stop', steps.stopServer)
    steps.exit(0)
  })
}
