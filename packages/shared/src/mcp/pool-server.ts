/**
 * MCP Pool Server
 *
 * Serves McpClientPool tools over HTTP using the MCP Streamable HTTP protocol.
 * This allows external SDK subprocesses (Codex, Copilot) to access pool-managed
 * MCP source tools through a single HTTP endpoint instead of connecting to each
 * source independently.
 *
 * Uses Streamable HTTP transport in stateless mode because Codex uses the
 * Streamable HTTP protocol (POST-based JSON-RPC). Stateless mode means no
 * session tracking — each request is independent.
 *
 * Architecture:
 *   Codex/Copilot SDK subprocess
 *       ↓ (HTTP Streamable HTTP protocol)
 *   McpPoolServer (this, in Electron main process)
 *       ↓
 *   McpClientPool
 *       ↓ (per-source MCP connections)
 *   Linear / GitHub / Notion / etc.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpClientPool } from './mcp-pool.ts';

export class McpPoolServer {
  private pool: McpClientPool;
  private httpServer: HttpServer | null = null;
  private mcpServer: Server | null = null;
  private transport: StreamableHTTPServerTransport | null = null;
  private debugFn: ((msg: string) => void) | undefined;
  private _port = 0;
  private stopPromise: Promise<void> | null = null;
  private stopped = false;
  private httpSockets = new Set<Socket>();

  constructor(pool: McpClientPool, options?: { debug?: (msg: string) => void }) {
    this.pool = pool;
    this.debugFn = options?.debug;
  }

  private debug(msg: string): void {
    this.debugFn?.(`[McpPoolServer] ${msg}`);
  }

  get port(): number {
    return this._port;
  }

  get url(): string {
    return `http://127.0.0.1:${this._port}/mcp`;
  }

  /**
   * Start the HTTP MCP server on a random port.
   * Returns the URL clients should connect to.
   */
  async start(): Promise<string> {
    if (this.stopped) {
      throw new Error('McpPoolServer cannot be restarted after stop');
    }
    if (this.httpServer) {
      return this.url;
    }

    // Create a single MCP Server + Streamable HTTP transport pair (stateless mode)
    this.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless — no session tracking
    });
    this.mcpServer = this.createMcpServer();
    await this.mcpServer.connect(this.transport);
    const transport = this.transport;

    this.httpServer = createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://127.0.0.1`);
      if (url.pathname !== '/mcp') {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      // Route all methods (POST, GET, DELETE) through the exact transport
      // captured for this one-shot server generation. stop() clears the field
      // synchronously, but an already accepted request must not dereference null.
      await transport.handleRequest(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(503);
        if (!res.writableEnded) res.end();
      });
    });
    this.httpServer.on('connection', (socket) => {
      this.httpSockets.add(socket);
      socket.once('close', () => this.httpSockets.delete(socket));
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(0, '127.0.0.1', () => {
        const addr = this.httpServer!.address();
        this._port = typeof addr === 'object' && addr ? addr.port : 0;
        this.debug(`Listening on 127.0.0.1:${this._port}`);
        resolve();
      });
      this.httpServer!.on('error', reject);
    });

    return this.url;
  }

  /**
   * Create an MCP Server instance wired to the pool.
   * Tools from pool use `mcp__craft__search_spaces` naming internally.
   * We strip the `mcp__` prefix so Codex (which adds its own `mcp__sources__`
   * prefix based on the POOL_SERVER_MCP_NAME) sees clean names:
   *   pool internal: mcp__craft__search_spaces
   *   exposed here:  craft__search_spaces
   *   Codex sees:    mcp__sources__craft__search_spaces
   */
  private createMcpServer(): Server {
    const server = new Server(
      { name: 'craft-pool-proxy', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );

    // List tools — proxy from pool, strip `mcp__` prefix
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const proxyDefs = this.pool.getProxyToolDefs();
      return {
        tools: proxyDefs.map(def => ({
          name: def.name.replace(/^mcp__/, ''),
          description: def.description,
          inputSchema: def.inputSchema as {
            type: 'object';
            properties?: Record<string, unknown>;
          },
        })),
      };
    });

    // Call tool — add `mcp__` prefix back before routing through pool
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const internalName = `mcp__${name}`;
      this.debug(`Tool call: ${name} → ${internalName}`);

      const result = await this.pool.callTool(internalName, args || {});

      return {
        content: [{ type: 'text' as const, text: result.content }],
        ...(result.isError ? { isError: true } : {}),
      };
    });

    return server;
  }

  /**
   * Notify that the tool list has changed.
   * In stateless mode this is a no-op — source changes already trigger
   * `regenCodexConfigAndReconnect()` which restarts the app-server,
   * and it re-discovers tools on startup.
   */
  notifyToolsChanged(): void {
    this.debug('Tools changed (stateless mode — clients will discover on next connect)');
  }

  /**
   * Stop the HTTP server and close the transport.
   */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }

  private async stopInternal(): Promise<void> {
    // Fence new requests first and capture exact resources before awaiting.
    const httpServer = this.httpServer;
    const httpSockets = Array.from(this.httpSockets);
    this.httpSockets.clear();
    const transport = this.transport;
    const mcpServer = this.mcpServer;
    this.httpServer = null;
    this.transport = null;
    this.mcpServer = null;
    this._port = 0;

    if (httpServer) {
      await this.closeHttpServerBounded(httpServer, httpSockets);
    }

    // SDK close should be quick, but neither SDK component is allowed to hold
    // the app shutdown indefinitely.
    await this.withTimeout(transport?.close(), 1_000);
    await this.withTimeout(mcpServer?.close(), 1_000);
    this.debug('Stopped');
  }

  private async closeHttpServerBounded(server: HttpServer, sockets: Socket[]): Promise<void> {
    const closed = new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    server.closeIdleConnections?.();

    // Give active requests a short grace period, then destroy only sockets
    // owned by this exact HTTP server. A final race bounds callback anomalies.
    await this.waitAtMost(closed, 250);
    // closeAllConnections does not consistently terminate partial request bodies
    // across Node/Bun versions, so also destroy the exact sockets accepted by
    // this server. No unrelated listener/process is touched.
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections?.();
    await this.waitAtMost(closed, 750);
  }

  private async withTimeout(work: Promise<unknown> | undefined, timeoutMs: number): Promise<void> {
    if (!work) return;
    await this.waitAtMost(work.catch(() => undefined), timeoutMs);
  }

  private waitAtMost(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (completed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(completed);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      void work.then(() => finish(true), () => finish(true));
    });
  }
}
