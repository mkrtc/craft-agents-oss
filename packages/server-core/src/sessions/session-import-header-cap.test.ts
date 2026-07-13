import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MAX_SESSION_HEADER_BYTES } from '@craft-agent/core'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('SessionManager oversized bundle import side effects', () => {
  it('rejects before creating the session directory or registering metadata', () => {
    const root = mkdtempSync(join(tmpdir(), 'session-manager-import-cap-'))
    tempDirs.push(root)
    const configDir = join(root, 'config')
    const workspaceRoot = join(root, 'workspace')
    mkdirSync(configDir, { recursive: true })
    mkdirSync(workspaceRoot, { recursive: true })
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      workspaces: [{ id: 'ws-cap', name: 'Cap Workspace', rootPath: workspaceRoot, createdAt: 1 }],
      activeWorkspaceId: 'ws-cap',
      activeSessionId: null,
    }))

    const moduleUrl = pathToFileURL(join(import.meta.dir, 'SessionManager.ts')).href
    const script = `
      import { existsSync } from 'node:fs';
      import { join } from 'node:path';
      const { SessionManager } = await import(${JSON.stringify(moduleUrl)});
      const sm = new SessionManager();
      const bundle = {
        version: 1,
        session: {
          header: {
            id: 'oversized-import',
            createdAt: 1,
            workspaceRootPath: '/source',
            transferredSessionSummary: 'x'.repeat(${MAX_SESSION_HEADER_BYTES}),
          },
          messages: [],
        },
        files: [],
      };
      let error = '';
      try {
        await sm.importSession('ws-cap', bundle, 'move');
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      console.log('RESULT:' + JSON.stringify({
        error,
        sessionDirExists: existsSync(join(${JSON.stringify(workspaceRoot)}, 'sessions', 'oversized-import')),
        registeredSessionCount: sm.getSessions('ws-cap').length,
      }));
    `
    const result = Bun.spawnSync([process.execPath, '--eval', script], {
      cwd: process.cwd(),
      env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(result.exitCode).toBe(0)
    const stdout = result.stdout.toString()
    const resultLine = stdout.split('\n').find(line => line.startsWith('RESULT:'))
    expect(resultLine, `stdout=${stdout}\nstderr=${result.stderr.toString()}`).toBeDefined()
    const payload = JSON.parse(resultLine!.slice('RESULT:'.length))
    expect(payload).toEqual({
      error: 'Invalid session bundle',
      sessionDirExists: false,
      registeredSessionCount: 0,
    })
    expect(existsSync(join(workspaceRoot, 'sessions', 'oversized-import'))).toBe(false)
  })
})
