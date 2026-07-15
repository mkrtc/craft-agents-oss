import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { McpClientPool } from '../mcp-pool.ts';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

describe('McpClientPool exact stdio process-tree teardown', () => {
  it('removes wrapper + SIGTERM-resistant grandchild and leaves unrelated group untouched', async () => {
    if (process.platform === 'win32') return;

    const dir = mkdtempSync(join(tmpdir(), 'craft-mcp-tree-'));
    const metadataPath = join(dir, 'tree.json');
    const fixturePath = join(import.meta.dir, 'fixtures', 'process-tree-mcp-server.ts');
    const pool = new McpClientPool();
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    unrelated.unref();

    let groupPid = 0;
    let wrapperPid = 0;
    let grandchildPid = 0;
    try {
      await pool.connect('tree-fixture', {
        type: 'stdio',
        command: process.execPath,
        args: [fixturePath],
        env: { CRAFT_MCP_TREE_METADATA: metadataPath },
      });

      const metadataReady = await waitUntil(() => {
        try {
          const parsed = JSON.parse(readFileSync(metadataPath, 'utf8')) as {
            groupPid: number;
            wrapperPid: number;
            grandchildPid: number;
          };
          groupPid = parsed.groupPid;
          wrapperPid = parsed.wrapperPid;
          grandchildPid = parsed.grandchildPid;
          return groupPid > 0 && wrapperPid > 0 && grandchildPid > 0;
        } catch {
          return false;
        }
      });
      expect(metadataReady).toBe(true);
      expect(isGroupAlive(groupPid)).toBe(true);
      expect(isAlive(wrapperPid)).toBe(true);
      expect(isAlive(grandchildPid)).toBe(true);
      expect(isAlive(unrelated.pid!)).toBe(true);

      const firstClose = pool.disconnectAll();
      await firstClose;

      expect(await waitUntil(() => !isGroupAlive(groupPid))).toBe(true);
      expect(isAlive(wrapperPid)).toBe(false);
      expect(isAlive(grandchildPid)).toBe(false);
      expect(isAlive(unrelated.pid!)).toBe(true);
      expect(isGroupAlive(unrelated.pid!)).toBe(true);
    } finally {
      await pool.disconnectAll().catch(() => {});
      if (groupPid && isGroupAlive(groupPid)) {
        try { process.kill(-groupPid, 'SIGKILL'); } catch {}
      }
      if (unrelated.pid && isGroupAlive(unrelated.pid)) {
        try { process.kill(-unrelated.pid, 'SIGKILL'); } catch {}
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
