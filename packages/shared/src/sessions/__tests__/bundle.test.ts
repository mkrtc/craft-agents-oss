import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { serializeSession, validateBundle, MAX_BUNDLE_SIZE_BYTES } from '../bundle'
import { writeSessionJsonl } from '../jsonl'
import type { StoredSession, SessionHeader } from '../types'

// ============================================================
// Helpers
// ============================================================

function makeTmpDir(): string {
  const dir = join(tmpdir(), `bundle-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function makeStoredSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: '260101-test-session',
    workspaceRootPath: '/tmp/ws',
    createdAt: 1000,
    lastUsedAt: 2000,
    name: 'Test Session',
    messages: [
      {
        id: 'msg-1',
        type: 'user',
        content: 'Hello world',
        timestamp: 1000,
      },
      {
        id: 'msg-2',
        type: 'assistant',
        content: 'Hi there!',
        timestamp: 1500,
      },
    ],
    tokenUsage: {
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      contextTokens: 100,
      costUsd: 0.001,
    },
    ...overrides,
  } as StoredSession
}

function setupSessionDir(workspaceRoot: string, session: StoredSession): string {
  const sessionsDir = join(workspaceRoot, 'sessions', session.id)
  mkdirSync(sessionsDir, { recursive: true })

  // Write JSONL
  const jsonlPath = join(sessionsDir, 'session.jsonl')
  writeSessionJsonl(jsonlPath, session)

  return sessionsDir
}

// ============================================================
// Tests
// ============================================================

describe('serializeSession', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
  })

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true })
    }
  })

  it('produces a valid bundle from a session directory', () => {
    const session = makeStoredSession()
    setupSessionDir(tmpDir, session)

    const bundle = serializeSession(tmpDir, session.id)

    expect(bundle).not.toBeNull()
    expect(bundle!.version).toBe(1)
    expect(bundle!.session.header.id).toBe(session.id)
    expect(bundle!.session.messages).toHaveLength(2)
    expect(bundle!.session.messages[0]!.content).toBe('Hello world')
    expect(bundle!.session.messages[1]!.content).toBe('Hi there!')
    expect(Array.isArray(bundle!.files)).toBe(true)
  })

  it('includes attachment files in bundle', () => {
    const session = makeStoredSession()
    const sessionDir = setupSessionDir(tmpDir, session)

    // Create an attachment
    const attachDir = join(sessionDir, 'attachments')
    mkdirSync(attachDir, { recursive: true })
    writeFileSync(join(attachDir, 'screenshot.png'), Buffer.from('fake-png-data'))

    const bundle = serializeSession(tmpDir, session.id)

    expect(bundle).not.toBeNull()
    expect(bundle!.files).toHaveLength(1)
    expect(bundle!.files[0]!.relativePath).toBe(join('attachments', 'screenshot.png'))
    expect(bundle!.files[0]!.size).toBe(13) // 'fake-png-data'.length
    // Verify base64 round-trips correctly
    const decoded = Buffer.from(bundle!.files[0]!.contentBase64, 'base64').toString()
    expect(decoded).toBe('fake-png-data')
  })

  it('includes plan and data files in bundle', () => {
    const session = makeStoredSession()
    const sessionDir = setupSessionDir(tmpDir, session)

    // Create plan and data files
    mkdirSync(join(sessionDir, 'plans'), { recursive: true })
    writeFileSync(join(sessionDir, 'plans', 'my-plan.md'), '# Plan\n- [ ] Step 1')

    mkdirSync(join(sessionDir, 'data'), { recursive: true })
    writeFileSync(join(sessionDir, 'data', 'result.json'), '{"rows":[]}')

    const bundle = serializeSession(tmpDir, session.id)

    expect(bundle).not.toBeNull()
    expect(bundle!.files).toHaveLength(2)
    const paths = bundle!.files.map(f => f.relativePath).sort()
    expect(paths).toEqual([join('data', 'result.json'), join('plans', 'my-plan.md')])
  })

  it('preserves notes.md in bundle', () => {
    const session = makeStoredSession()
    const sessionDir = setupSessionDir(tmpDir, session)

    writeFileSync(join(sessionDir, 'notes.md'), '# My Notes\nSome notes here.')

    const bundle = serializeSession(tmpDir, session.id)

    expect(bundle).not.toBeNull()
    const notesFile = bundle!.files.find(f => f.relativePath === 'notes.md')
    expect(notesFile).toBeDefined()
    expect(Buffer.from(notesFile!.contentBase64, 'base64').toString()).toBe('# My Notes\nSome notes here.')
  })

  it('skips tmp/ directory', () => {
    const session = makeStoredSession()
    const sessionDir = setupSessionDir(tmpDir, session)

    mkdirSync(join(sessionDir, 'tmp'), { recursive: true })
    writeFileSync(join(sessionDir, 'tmp', 'cache.dat'), 'cached data')

    const bundle = serializeSession(tmpDir, session.id)

    expect(bundle).not.toBeNull()
    const tmpFiles = bundle!.files.filter(f => f.relativePath.startsWith('tmp'))
    expect(tmpFiles).toHaveLength(0)
  })

  it('skips dotfiles', () => {
    const session = makeStoredSession()
    const sessionDir = setupSessionDir(tmpDir, session)

    writeFileSync(join(sessionDir, '.hidden'), 'secret')

    const bundle = serializeSession(tmpDir, session.id)

    expect(bundle).not.toBeNull()
    const dotFiles = bundle!.files.filter(f => f.relativePath.startsWith('.'))
    expect(dotFiles).toHaveLength(0)
  })

  it('does not include session.jsonl in files array', () => {
    const session = makeStoredSession()
    setupSessionDir(tmpDir, session)

    const bundle = serializeSession(tmpDir, session.id)

    expect(bundle).not.toBeNull()
    const jsonlFiles = bundle!.files.filter(f => f.relativePath.includes('session.jsonl'))
    expect(jsonlFiles).toHaveLength(0)
  })

  it('returns null for non-existent session', () => {
    const bundle = serializeSession(tmpDir, 'non-existent')
    expect(bundle).toBeNull()
  })

  it('canonicalizes Memory selection in exported headers', () => {
    const session = makeStoredSession({
      enabledMemorySpaceRefs: [{
        connectionId: '123E4567-E89B-42D3-8456-426614174000',
        spaceId: 'AAAAAAAA-E89B-42D3-8456-426614174000',
      }],
      memoryWriteTargetRef: {
        connectionId: '123E4567-E89B-42D3-8456-426614174000',
        spaceId: 'AAAAAAAA-E89B-42D3-8456-426614174000',
      },
      memorySelectionMode: 'explicit',
    })
    setupSessionDir(tmpDir, session)

    const bundle = serializeSession(tmpDir, session.id)

    expect(bundle?.session.header.enabledMemorySpaceRefs).toEqual([{
      connectionId: '123e4567-e89b-42d3-8456-426614174000',
      spaceId: 'aaaaaaaa-e89b-42d3-8456-426614174000',
    }])
  })

  it('preserves session metadata in header', () => {
    const session = makeStoredSession({
      isFlagged: true,
      sessionStatus: 'in-progress',
      labels: ['bug', 'priority::high'],
      permissionMode: 'ask' as any,
    })
    setupSessionDir(tmpDir, session)

    const bundle = serializeSession(tmpDir, session.id)

    expect(bundle).not.toBeNull()
    expect(bundle!.session.header.isFlagged).toBe(true)
    expect(bundle!.session.header.sessionStatus).toBe('in-progress')
    expect(bundle!.session.header.labels).toEqual(['bug', 'priority::high'])
  })
})

describe('validateBundle', () => {
  it('accepts valid bundle', () => {
    const bundle = {
      version: 1,
      session: {
        header: { id: 'test', createdAt: 1000 },
        messages: [],
      },
      files: [],
    }
    expect(validateBundle(bundle)).toBe(true)
  })

  it('rejects null', () => {
    expect(validateBundle(null)).toBe(false)
  })

  it('rejects wrong version', () => {
    expect(validateBundle({ version: 2, session: { header: { id: 'x', createdAt: 1 }, messages: [] }, files: [] })).toBe(false)
  })

  it('rejects missing session', () => {
    expect(validateBundle({ version: 1, files: [] })).toBe(false)
  })

  it('rejects missing header', () => {
    expect(validateBundle({ version: 1, session: { messages: [] }, files: [] })).toBe(false)
  })

  it('rejects missing messages array', () => {
    expect(validateBundle({ version: 1, session: { header: { id: 'x', createdAt: 1 } }, files: [] })).toBe(false)
  })

  it('rejects missing files array', () => {
    expect(validateBundle({ version: 1, session: { header: { id: 'x', createdAt: 1 }, messages: [] } })).toBe(false)
  })

  it('rejects header without id', () => {
    expect(validateBundle({ version: 1, session: { header: { createdAt: 1 }, messages: [] }, files: [] })).toBe(false)
  })

  it('rejects header without createdAt', () => {
    expect(validateBundle({ version: 1, session: { header: { id: 'x' }, messages: [] }, files: [] })).toBe(false)
  })

  it.each([
    ['51 refs', { enabledMemorySpaceRefs: Array.from({ length: 51 }, () => ({ connectionId: '123e4567-e89b-42d3-8456-426614174000', spaceId: 'aaaaaaaa-e89b-42d3-8456-426614174000' })) }],
    ['unknown nested fields', { enabledMemorySpaceRefs: [{ connectionId: '123e4567-e89b-42d3-8456-426614174000', spaceId: 'aaaaaaaa-e89b-42d3-8456-426614174000', injected: true }] }],
    ['duplicate refs', { enabledMemorySpaceRefs: [{ connectionId: '123e4567-e89b-42d3-8456-426614174000', spaceId: 'aaaaaaaa-e89b-42d3-8456-426614174000' }, { connectionId: '123e4567-e89b-42d3-8456-426614174000', spaceId: 'aaaaaaaa-e89b-42d3-8456-426614174000' }] }],
    ['invalid selection mode', { memorySelectionMode: 'derived' }],
  ])('rejects imported bundle with malformed Memory selection: %s', (_name, memorySelection) => {
    expect(validateBundle({
      version: 1,
      session: { header: { id: 'test', createdAt: 1000, ...memorySelection }, messages: [] },
      files: [],
    })).toBe(false)
  })
})
