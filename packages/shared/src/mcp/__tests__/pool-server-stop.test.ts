import { describe, expect, it } from 'bun:test';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { McpClientPool } from '../mcp-pool.ts';
import { McpPoolServer } from '../pool-server.ts';

describe('McpPoolServer bounded stop', () => {
  it('memoizes stop and force-closes an owned active HTTP connection', async () => {
    const server = new McpPoolServer(new McpClientPool());
    await server.start();

    const socket = createConnection({ host: '127.0.0.1', port: server.port });
    await once(socket, 'connect');
    // Keep an active, incomplete request open so httpServer.close() alone would wait.
    socket.write(
      'POST /mcp HTTP/1.1\r\n' +
      'Host: 127.0.0.1\r\n' +
      'Accept: application/json, text/event-stream\r\n' +
      'Content-Type: application/json\r\n' +
      'Content-Length: 9999\r\n\r\n{',
    );
    // Let the server accept the partial body as an active request before stop.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const startedAt = Date.now();
    const first = server.stop();
    const second = server.stop();
    expect(second).toBe(first);
    await first;

    expect(Date.now() - startedAt).toBeLessThan(1_500);
    await Promise.race([
      once(socket, 'close'),
      new Promise((resolve) => setTimeout(resolve, 100)),
    ]);
    expect(socket.destroyed).toBe(true);
    await expect(server.start()).rejects.toThrow('cannot be restarted');
  }, 5_000);
});
