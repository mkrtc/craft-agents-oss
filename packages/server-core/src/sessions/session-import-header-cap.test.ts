import { afterEach, describe, expect, it } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MAX_SESSION_HEADER_BYTES } from '@craft-agent/core'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function runScenario(body: string): Record<string, unknown> {
  const root = mkdtempSync(join(tmpdir(), 'session-manager-import-cap-'))
  tempDirs.push(root)
  const configDir = join(root, 'config')
  const workspaceRoot = join(root, 'workspace-with-a-deliberately-long-target-path')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(workspaceRoot, { recursive: true })
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    workspaces: [{ id: 'ws-cap', name: 'Cap Workspace', rootPath: workspaceRoot, createdAt: 1 }],
    activeWorkspaceId: 'ws-cap',
    activeSessionId: null,
  }))
  copyFileSync(join(process.cwd(), 'apps/electron/resources/config-defaults.json'), join(configDir, 'config-defaults.json'))

  const moduleUrl = pathToFileURL(join(import.meta.dir, 'SessionManager.ts')).href
  const script = `
    import { existsSync, readFileSync, readdirSync } from 'node:fs';
    import { join } from 'node:path';
    const { SessionManager } = await import(${JSON.stringify(moduleUrl)});
    const workspaceRoot = ${JSON.stringify(workspaceRoot)};
    const sm = new SessionManager();
    let eventCount = 0;
    sm.setEventSink(() => { eventCount++; });
    const scenario = await (async () => { ${body} })();
    console.log('RESULT:' + JSON.stringify({ ...scenario, eventCount }));
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
  return JSON.parse(resultLine!.slice('RESULT:'.length))
}

describe('SessionManager transactional header preflight and import baselines', () => {
  it('retains source-bundle over-cap validation with no side effects', () => {
    const payload = runScenario(`
      const bundle = {
        version: 1,
        session: { header: {
          id: 'oversized-import', createdAt: 1, workspaceRootPath: '/source',
          transferredSessionSummary: 'x'.repeat(${MAX_SESSION_HEADER_BYTES}),
        }, messages: [] },
        files: [],
      };
      let error = '';
      try { await sm.importSession('ws-cap', bundle, 'move'); }
      catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
      return {
        error,
        sessionDirExists: existsSync(join(workspaceRoot, 'sessions', 'oversized-import')),
        registeredSessionCount: sm.getSessions('ws-cap').length,
      };
    `)
    expect(payload).toEqual({
      error: 'Invalid session bundle',
      sessionDirExists: false,
      registeredSessionCount: 0,
      eventCount: 0,
    })
  })

  it('rejects a source header exactly at cap when target reconstruction expands over cap', () => {
    const payload = runScenario(`
      const header = { id: 'expanded-import', createdAt: 1, workspaceRootPath: '/s', transferredSessionSummary: '' };
      const baseBytes = Buffer.byteLength(JSON.stringify(header), 'utf8');
      header.transferredSessionSummary = 'x'.repeat(${MAX_SESSION_HEADER_BYTES} - baseBytes);
      const sourceBytes = Buffer.byteLength(JSON.stringify(header), 'utf8');
      const bundle = { version: 1, session: { header, messages: [] }, files: [] };
      let error = '';
      try { await sm.importSession('ws-cap', bundle, 'move'); }
      catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
      return {
        error,
        sourceBytes,
        sessionDirExists: existsSync(join(workspaceRoot, 'sessions', 'expanded-import')),
        registeredSessionCount: sm.getSessions('ws-cap').length,
      };
    `)
    expect(payload.sourceBytes).toBe(MAX_SESSION_HEADER_BYTES)
    expect(String(payload.error)).toContain('Session header exceeds')
    expect(payload).toMatchObject({ sessionDirExists: false, registeredSessionCount: 0, eventCount: 0 })
  })

  it('rejects an oversized remote summary before directory, runtime, or event side effects', () => {
    const payload = runScenario(`
      let error = '';
      try {
        await sm.importRemoteSessionTransfer('ws-cap', {
          sourceSessionId: 'source', name: 'Remote', summary: 'x'.repeat(${MAX_SESSION_HEADER_BYTES}),
        });
      } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
      const sessionsDir = join(workspaceRoot, 'sessions');
      return {
        error,
        sessionDirectoryCount: existsSync(sessionsDir) ? readdirSync(sessionsDir).length : 0,
        registeredSessionCount: sm.getSessions('ws-cap').length,
      };
    `)
    expect(String(payload.error)).toContain('Session header exceeds')
    expect(payload).toMatchObject({ sessionDirectoryCount: 0, registeredSessionCount: 0, eventCount: 0 })
  })

  it('rejects oversized create metadata before directory, runtime, or event side effects', () => {
    const payload = runScenario(`
      let error = '';
      try { await sm.createSession('ws-cap', { name: 'x'.repeat(${MAX_SESSION_HEADER_BYTES}) }); }
      catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
      const sessionsDir = join(workspaceRoot, 'sessions');
      return {
        error,
        sessionDirectoryCount: existsSync(sessionsDir) ? readdirSync(sessionsDir).length : 0,
        registeredSessionCount: sm.getSessions('ws-cap').length,
      };
    `)
    expect(String(payload.error)).toContain('Session header exceeds')
    expect(payload).toMatchObject({ sessionDirectoryCount: 0, registeredSessionCount: 0, eventCount: 0 })
  })

  it('persists the first rename after direct bundle import', () => {
    const payload = runScenario(`
      const bundle = {
        version: 1,
        session: { header: { id: 'bundle-first-update', createdAt: 1, workspaceRootPath: '/source', name: 'A' }, messages: [] },
        files: [],
      };
      const imported = await sm.importSession('ws-cap', bundle, 'move');
      await sm.renameSession(imported.sessionId, 'B');
      await sm.flushSession(imported.sessionId);
      const header = JSON.parse(readFileSync(join(workspaceRoot, 'sessions', imported.sessionId, 'session.jsonl'), 'utf8').split('\\n')[0]);
      return { diskName: header.name, runtimeName: sm.getSessions('ws-cap')[0]?.name };
    `)
    expect(payload).toMatchObject({ diskName: 'B', runtimeName: 'B' })
  })

  it('persists the first rename after remote transfer import', () => {
    const payload = runScenario(`
      const imported = await sm.importRemoteSessionTransfer('ws-cap', {
        sourceSessionId: 'source', name: 'A', summary: 'remote summary',
      });
      await sm.renameSession(imported.sessionId, 'B');
      await sm.flushSession(imported.sessionId);
      const header = JSON.parse(readFileSync(join(workspaceRoot, 'sessions', imported.sessionId, 'session.jsonl'), 'utf8').split('\\n')[0]);
      return {
        diskName: header.name,
        runtimeName: sm.getSessions('ws-cap')[0]?.name,
        summary: header.transferredSessionSummary,
      };
    `)
    expect(payload).toMatchObject({ diskName: 'B', runtimeName: 'B', summary: 'remote summary' })
  })
})
