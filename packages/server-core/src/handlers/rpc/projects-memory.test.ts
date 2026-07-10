import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { ProjectMemoryStore, ProjectMemoryPayload, ProjectMemorySearchInput, ProjectMemoryAddInput, ProjectMemoryStatus } from '@craft-agent/shared/project-memory'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport/types'
import type { HandlerDeps } from '../handler-deps'

const configDir = mkdtempSync(join(tmpdir(), 'craft-memory-rpc-config-'))
const workspaceRoot = join(configDir, 'workspaces', 'test-workspace')
const projectId = 'proj_canonical'
const projectSlug = 'memory-project'

let handlers: Map<string, HandlerFn>
let setProjectMemoryStoreForTests: (store: ProjectMemoryStore | null) => void
let registerProjectsHandlers: (server: RpcServer, deps: HandlerDeps) => void

function makePayload(input: ProjectMemoryAddInput): ProjectMemoryPayload {
  return {
    id: 'mem_1',
    scope: input.scope,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    source: input.source,
    title: input.title,
    content: input.content,
    contentHash: 'hash',
    createdAt: 1,
    updatedAt: 2,
    tags: input.tags,
  }
}

function createStore(status: ProjectMemoryStatus = {
  enabled: true,
  provider: 'qdrant',
  url: 'http://qdrant',
  collection: 'craft_memory',
  dimension: 64,
  ok: true,
}) {
  const calls: { add?: ProjectMemoryAddInput; search?: ProjectMemorySearchInput } = {}
  const store: ProjectMemoryStore = {
    async status() { return status },
    async add(input) {
      calls.add = input
      return makePayload(input)
    },
    async search(input) {
      calls.search = input
      return [{ score: 0.75, payload: makePayload({
        scope: 'project',
        workspaceId: input.scopes[0]?.workspaceId,
        projectId: input.scopes[0]?.projectId,
        source: 'decision',
        title: 'Decision',
        content: 'Use Qdrant.',
        tags: ['architecture'],
      }) }]
    },
  }
  return { store, calls }
}

function server(): RpcServer {
  handlers = new Map()
  return {
    handle(channel, handler) { handlers.set(channel, handler) },
    push() {},
    async invokeClient() { return undefined },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
}

function deps(): HandlerDeps {
  return {
    sessionManager: {} as HandlerDeps['sessionManager'],
    platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } } as HandlerDeps['platform'],
    oauthFlowStore: {} as HandlerDeps['oauthFlowStore'],
  }
}

function ctx(workspaceId: string | null = 'test-workspace'): RequestContext {
  return { clientId: 'client-1', workspaceId, webContentsId: 1 }
}

function handler(channel: string): HandlerFn {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`Missing handler ${channel}`)
  return fn
}

beforeAll(async () => {
  process.env.CRAFT_CONFIG_DIR = configDir
  mkdirSync(join(workspaceRoot, 'projects', projectSlug), { recursive: true })
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    workspaces: [{
      id: 'test-workspace',
      name: 'Test Workspace',
      slug: 'test-workspace',
      rootPath: workspaceRoot,
      createdAt: 1,
    }],
    activeWorkspaceId: 'test-workspace',
    activeSessionId: null,
  }, null, 2))
  writeFileSync(join(workspaceRoot, 'projects', projectSlug, 'config.json'), JSON.stringify({
    id: projectId,
    slug: projectSlug,
    name: 'Memory Project',
    createdAt: 1,
    updatedAt: 1,
  }, null, 2))

  ;({ setProjectMemoryStoreForTests } = await import('@craft-agent/shared/project-memory'))
  ;({ registerProjectsHandlers } = await import('./projects'))
})

afterEach(() => {
  setProjectMemoryStoreForTests(null)
})

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true })
})

describe('project memory RPC handlers', () => {
  it('normalizes ready, disabled, not-initialized, config-mismatch, unreachable, and generic error statuses', async () => {
    registerProjectsHandlers(server(), deps())
    const statusHandler = handler(RPC_CHANNELS.projects.MEMORY_STATUS)

    for (const [error, state] of [
      ['Qdrant 404 Not Found: collection does not exist', 'not-initialized'],
      ['Qdrant collection vector size 3 does not match expected 64', 'config-mismatch'],
      ['Qdrant collection distance Dot does not match expected Cosine', 'config-mismatch'],
      ['fetch failed: ECONNREFUSED', 'unreachable'],
      ['permission denied', 'error'],
    ] as const) {
      setProjectMemoryStoreForTests(createStore({ enabled: true, provider: 'qdrant', url: 'http://qdrant', collection: 'craft_memory', dimension: 64, ok: false, error }).store)
      expect((await statusHandler(ctx())).state).toBe(state)
    }

    setProjectMemoryStoreForTests(createStore().store)
    expect((await statusHandler(ctx())).state).toBe('ready')

    setProjectMemoryStoreForTests(createStore({ enabled: false, provider: 'qdrant', url: 'http://qdrant', collection: 'craft_memory', dimension: 64, ok: false, error: 'disabled' }).store)
    expect((await statusHandler(ctx())).state).toBe('disabled')
  })

  it('rejects missing workspace and missing project', async () => {
    const { store } = createStore()
    setProjectMemoryStoreForTests(store)
    registerProjectsHandlers(server(), deps())
    const add = handler(RPC_CHANNELS.projects.MEMORY_ADD)

    await expect(add(ctx(null), { projectIdOrSlug: projectSlug, source: 'decision', content: 'x' })).rejects.toThrow('Workspace context is required')
    await expect(add(ctx(), { projectIdOrSlug: 'missing', source: 'decision', content: 'x' })).rejects.toThrow('Project not found')
  })

  it('uses canonical workspace/project ids and ignores spoofed raw scope inputs on add', async () => {
    const { store, calls } = createStore()
    setProjectMemoryStoreForTests(store)
    registerProjectsHandlers(server(), deps())

    const result = await handler(RPC_CHANNELS.projects.MEMORY_ADD)(ctx(), {
      projectIdOrSlug: projectSlug,
      source: 'decision',
      title: '  Direction  ',
      content: '  Use Qdrant.  ',
      tags: [' architecture ', 'architecture'],
      scope: 'global',
      workspaceId: 'spoofed-workspace',
      projectId: 'spoofed-project',
    })

    expect(calls.add).toMatchObject({
      scope: 'project',
      workspaceId: 'test-workspace',
      projectId,
      source: 'decision',
      title: 'Direction',
      content: 'Use Qdrant.',
      tags: ['architecture'],
    })
    expect(result).toMatchObject({ id: 'mem_1', projectId, source: 'decision', content: 'Use Qdrant.' })
    expect('scope' in result).toBe(false)
  })

  it('enforces project-only search and ignores spoofed raw scopes', async () => {
    const { store, calls } = createStore()
    setProjectMemoryStoreForTests(store)
    registerProjectsHandlers(server(), deps())

    const result = await handler(RPC_CHANNELS.projects.MEMORY_SEARCH)(ctx(), {
      projectIdOrSlug: projectId,
      query: '  qdrant  ',
      limit: 3,
      scopes: [{ scope: 'global' }],
      workspaceId: 'spoofed-workspace',
    })

    expect(calls.search).toEqual({
      query: 'qdrant',
      scopes: [{ scope: 'project', workspaceId: 'test-workspace', projectId }],
      limit: 3,
    })
    expect(result[0]).toMatchObject({ score: 0.75, payload: { projectId, source: 'decision' } })
    expect('scope' in result[0].payload).toBe(false)
  })

  it('validates source/content/tags at the server boundary', async () => {
    const { store } = createStore()
    setProjectMemoryStoreForTests(store)
    registerProjectsHandlers(server(), deps())
    const add = handler(RPC_CHANNELS.projects.MEMORY_ADD)

    await expect(add(ctx(), { projectIdOrSlug: projectSlug, source: 'file', content: 'x' })).rejects.toThrow('source must be manual-note or decision')
    await expect(add(ctx(), { projectIdOrSlug: projectSlug, source: 'decision', content: '   ' })).rejects.toThrow('content is required')
    await expect(add(ctx(), { projectIdOrSlug: projectSlug, source: 'decision', content: 'x', tags: [''] })).rejects.toThrow('tags must not be empty')
    await expect(add(ctx(), { projectIdOrSlug: projectSlug, source: 'decision', content: 'x', tags: ['a'.repeat(65)] })).rejects.toThrow('tags must be at most')
  })
})
