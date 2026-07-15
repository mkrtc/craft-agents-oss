import { existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const mode = process.argv[2];
const pathArg = process.argv[3];

if (mode === '--grandchild') {
  if (!pathArg) throw new Error('Grandchild ready path is required');
  process.on('SIGTERM', () => {});
  process.on('SIGINT', () => {});
  writeFileSync(pathArg, String(process.pid), 'utf8');
  setInterval(() => {}, 1_000);
} else {
  const metadataPath = process.env.CRAFT_MCP_TREE_METADATA!;
  const readyPath = `${metadataPath}.grandchild-ready`;
  const grandchild = spawn(process.execPath, [import.meta.path, '--grandchild', readyPath], {
    stdio: 'ignore',
    detached: false,
  });

  const deadline = Date.now() + 5_000;
  while (!existsSync(readyPath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!existsSync(readyPath) || !grandchild.pid) {
    throw new Error('Grandchild fixture failed to become ready');
  }

  writeFileSync(metadataPath, JSON.stringify({
    groupPid: process.ppid,
    wrapperPid: process.pid,
    grandchildPid: grandchild.pid,
  }), 'utf8');

  const server = new Server(
    { name: 'process-tree-fixture', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  await server.connect(new StdioServerTransport());
}
