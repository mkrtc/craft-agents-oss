import { describe, expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import { PiAgent } from '../pi-agent.ts'
import { createMockBackendConfig } from './test-utils.ts'

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

const linuxIt = process.platform === 'linux' ? it : it.skip

describe('Pi exact process-tree disposal', () => {
  linuxIt('SIGTERM → SIGKILL removes the exact owned child group and grandchild', async () => {
    const childScript = `
      const { spawn } = require('node:child_process');
      process.on('SIGTERM', () => {});
      const grandchild = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: 'ignore' });
      console.log(grandchild.pid);
      setInterval(() => {}, 1000);
    `
    const child = spawn(process.execPath, ['-e', childScript], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const childPid = child.pid!
    const grandchildPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('grandchild PID fixture timed out')), 2_000)
      child.stdout!.once('data', (chunk) => {
        clearTimeout(timer)
        resolve(Number(String(chunk).trim()))
      })
      child.once('error', reject)
    })

    const agent = new PiAgent(createMockBackendConfig({ provider: 'pi', isHeadless: true }))
    ;(agent as any).subprocess = child

    try {
      const result = await agent.disposeRuntime({ reason: 'manual', deadline: Date.now() + 4_000 })
      expect(result).toMatchObject({
        outcome: 'forced',
        observedExit: true,
        pid: childPid,
        attemptedGraceful: true,
        forced: true,
        provider: 'pi',
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(isAlive(childPid)).toBe(false)
      expect(isAlive(grandchildPid)).toBe(false)
    } finally {
      if (isAlive(childPid)) {
        try { process.kill(-childPid, 'SIGKILL') } catch {}
      }
    }
  })
})
