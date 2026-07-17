import { afterEach, describe, expect, it } from 'bun:test'
import WebSocket from 'ws'
import { PROTOCOL_VERSION } from '@craft-agent/shared/protocol'
import { WsRpcServer } from '@craft-agent/server-core/transport'
import { captureTransportCounters } from './main-memory'

const TOKEN = 'crft-main-memory-diagnostic-test-token'

async function connect(server: WsRpcServer): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}`)
    const timeout = setTimeout(() => reject(new Error('timeout')), 2_000)
    socket.on('open', () => {
      socket.send(JSON.stringify({
        id: 'handshake',
        type: 'handshake',
        protocolVersion: PROTOCOL_VERSION,
        token: TOKEN,
        workspaceId: 'synthetic-workspace',
      }))
    })
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString()) as { type?: string }
      if (message.type !== 'handshake_ack') return
      clearTimeout(timeout)
      resolve(socket)
    })
    socket.on('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition timeout')
}

describe('CRFT diagnostic transport buffer accounting', () => {
  let server: WsRpcServer | undefined
  let socket: WebSocket | undefined

  afterEach(() => {
    socket?.terminate()
    server?.close()
  })

  it('accounts exact connected and disconnected replay entries and UTF-8 bytes', async () => {
    server = new WsRpcServer({
      host: '127.0.0.1',
      port: 0,
      requireAuth: true,
      validateToken: async token => token === TOKEN,
      serverId: 'diagnostic-test',
    })
    await server.listen()
    socket = await connect(server)

    server.push('diag:event-a', { to: 'all' }, { bytes: 32 })
    server.push('diag:event-b', { to: 'all' }, { bytes: 2_048 })

    const connected = captureTransportCounters(server)
    expect(connected.connectedClientCount).toBe(1)
    expect(connected.disconnectedClientCount).toBe(0)
    expect(connected.totalEntryCount).toBe(2)
    expect(connected.totalBytes).toBeGreaterThan(0)
    expect(connected.perClient).toEqual([{
      clientHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      state: 'connected',
      entryCount: 2,
      bytes: connected.totalBytes,
    }])
    expect(JSON.stringify(connected)).not.toContain('synthetic-workspace')
    expect(JSON.stringify(connected)).not.toContain('diag:event-a')

    socket.close()
    await waitFor(() => server!.getConnectedClientCount() === 0)
    const disconnected = captureTransportCounters(server)
    expect(disconnected.connectedClientCount).toBe(0)
    expect(disconnected.disconnectedClientCount).toBe(1)
    expect(disconnected.totalEntryCount).toBe(2)
    expect(disconnected.totalBytes).toBe(connected.totalBytes)
    expect(disconnected.perClient[0]!.state).toBe('disconnected')
  })

  it('fails closed when a buffer entry cannot be read', () => {
    const malformed = {
      clients: new Map([['client', { id: 'client', eventBuffer: [{ seq: 1, data: null, timestamp: 1 }] }]]),
      disconnectedClients: new Map(),
    }
    expect(() => captureTransportCounters(malformed as unknown as WsRpcServer))
      .toThrow('Transport buffer entry is unreadable')
  })
})
