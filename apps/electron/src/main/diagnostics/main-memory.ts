import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { getHeapStatistics } from 'node:v8'
import WebSocket from 'ws'
import { PROTOCOL_VERSION } from '@craft-agent/shared/protocol'
import { getSessionFilePath, writeSessionJsonl, type StoredSession } from '@craft-agent/shared/sessions'
import type { Message, StoredMessage } from '@craft-agent/core/types'
import type { SessionManager } from '@craft-agent/server-core/sessions'
import type { WsRpcServer } from '@craft-agent/server-core/transport'

export const MAIN_MEMORY_DIAGNOSTIC_GATE = 'CRAFT_DIAG_MAIN_MEMORY'
export const MAIN_MEMORY_DIAGNOSTIC_SCHEMA = 'craft.main-memory-diagnostic'
export const MAIN_MEMORY_DIAGNOSTIC_VERSION = 1
export const MAIN_MEMORY_DIAGNOSTIC_PROTOCOL = 'CRFT-MAIN-MEM-V1'
export const SYNTHETIC_SESSION_COUNT = 25
export const BASELINE_IDLE_MS = 60_000
export const SESSION_OPEN_SPACING_MS = 5_000
export const WORKLOAD_TICK_MS = 50
export const WORKLOAD_TICK_COUNT = 1_200
export const WORKLOAD_DURATION_MS = WORKLOAD_TICK_MS * WORKLOAD_TICK_COUNT
export const POST_WORKLOAD_IDLE_MS = 300_000
export const SAMPLE_INTERVAL_MS = 1_000

const DIAGNOSTIC_DRIVER_ARG = '--craft-diag-main-memory-driver'
const DIAGNOSTIC_SMOKE_ARG = '--craft-diag-main-memory-smoke'
const ZERO_TOKEN_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  contextTokens: 0,
  costUsd: 0,
}

export type DiagnosticStage =
  | 'baseline'
  | `open-${string}`
  | 'post-load'
  | 'post-workload'
  | 'post-idle'
  | 'smoke'

interface DiagnosticManagedSession {
  id: string
  messagesLoaded: boolean
  messages: Message[]
  runtimeGeneration?: unknown
  backgroundTaskRegistry: Map<string, unknown>
  backgroundShellCommands: Map<string, string>
  backgroundTaskOutputs: Map<string, { outputFile: string; summary: string; status: string; completedAt: number }>
}

interface DiagnosticRuntimeEntry {
  managed: DiagnosticManagedSession
  generation: Record<string, unknown>
}

interface SessionManagerInternals {
  sessions: Map<string, DiagnosticManagedSession>
  runtimeRegistry: Map<string, DiagnosticRuntimeEntry>
}

interface DiagnosticBufferedEvent {
  seq: number
  data: string
  timestamp: number
}

interface DiagnosticTransportClient {
  id: string
  eventBuffer: DiagnosticBufferedEvent[]
}

interface TransportInternals {
  clients: Map<string, DiagnosticTransportClient>
  disconnectedClients: Map<string, { client: DiagnosticTransportClient }>
}

export interface DiagnosticClock {
  now(): number
  sleep(ms: number): Promise<void>
}

export interface DiagnosticProtocolTiming {
  baselineIdleMs: number
  sessionOpenSpacingMs: number
  workloadDurationMs: number
  postWorkloadIdleMs: number
}

export interface DiagnosticProtocolScheduleHooks {
  clock: DiagnosticClock
  timing: DiagnosticProtocolTiming
  openSession(index: number): Promise<void>
  runWorkload(): Promise<void>
  capture(stage: DiagnosticStage, logicalElapsedMs: number, gcCheckpoint: boolean): Promise<void>
}

export interface SyntheticSessionPlanEntry {
  ordinal: number
  sessionId: string
  sessionHash: string
  messageCount: number
  payloadBytesPerMessage: number
  logicalPayloadBytes: number
}

export interface SyntheticFixturePlan {
  generator: 'CRFT-MAIN-MEM-V1-SYNTHETIC-25'
  version: 1
  sessions: SyntheticSessionPlanEntry[]
  manifestHash: string
}

export interface WorkloadTraceManifest {
  generator: 'CRFT-MAIN-MEM-V1-WORKLOAD'
  version: 1
  tickMs: number
  ticks: number
  durationMs: number
  textDeltaCount: number
  textDeltaBytes: number
  toolResultCount: number
  toolResultBytes: number
  backgroundTaskCount: number
  transportEventCount: number
  traceHash: string
}

export interface DiagnosticSessionCounters {
  loadedSessionCount: number
  totalMessages: number
  retainedBytesEstimate: number
  perSession: Array<{
    sessionHash: string
    messageCount: number
    retainedBytesEstimate: number
  }>
}

export interface DiagnosticRuntimeCounters {
  generationCount: number
  liveGenerationCount: number
  retainedBytesEstimate: number
}

export interface DiagnosticBackgroundCounters {
  taskRegistryCount: number
  taskRegistryRetainedBytesEstimate: number
  shellCommandCount: number
  shellCommandRetainedBytes: number
  taskOutputCount: number
  retainedOutputBytes: number
  taskOutputRetainedBytesEstimate: number
}

export interface DiagnosticTransportCounters {
  connectedClientCount: number
  disconnectedClientCount: number
  totalEntryCount: number
  totalBytes: number
  perClient: Array<{
    clientHash: string
    state: 'connected' | 'disconnected'
    entryCount: number
    bytes: number
  }>
}

export interface DiagnosticPidRecord {
  pid: number
  parentPid: number
  processNameHash: string
  rssBytes: number
  privateBytes: number | null
  privateBytesAvailable: boolean
  cpuUserTicks: number
  cpuSystemTicks: number
}

export interface DiagnosticProcessCounters {
  memoryUsage: NodeJS.MemoryUsage
  heapStatistics: ReturnType<typeof getHeapStatistics>
  pidTree: DiagnosticPidRecord[]
  pidTreeHash: string
  mainPrivateBytes: number | null
  nativeResidualEstimate: {
    label: 'estimate-not-ownership-proof'
    formula: 'max(0, mainPrivateBytes - (heapTotal + external))'
    bytes: number | null
  }
}

export interface DiagnosticCounters {
  transcripts: DiagnosticSessionCounters
  runtimes: DiagnosticRuntimeCounters
  background: DiagnosticBackgroundCounters
  transport: DiagnosticTransportCounters
  process: DiagnosticProcessCounters
}

export interface ExplicitGcResult {
  requested: boolean
  available: boolean
  completed: boolean
}

interface DiagnosticBaseRecord {
  schema: typeof MAIN_MEMORY_DIAGNOSTIC_SCHEMA
  version: typeof MAIN_MEMORY_DIAGNOSTIC_VERSION
  protocol: typeof MAIN_MEMORY_DIAGNOSTIC_PROTOCOL
  gitSha: string
  runId: string
  sequence: number
  timestamp: string
  logicalElapsedMs: number
  pid: number
  fixtureManifestHash: string
  workloadTraceHash: string
}

export interface DiagnosticSnapshotRecord extends DiagnosticBaseRecord {
  kind: 'snapshot' | 'sample'
  stage: DiagnosticStage
  gc: ExplicitGcResult
  counters: DiagnosticCounters
  recordHash: string
}

interface DiagnosticLifecycleRecord extends DiagnosticBaseRecord {
  kind: 'run-start' | 'run-complete' | 'run-error'
  stage: DiagnosticStage
  status: 'running' | 'complete' | 'error'
  errorCode?: string
  recordHash: string
}

export interface MainMemoryDiagnosticContext {
  sessionManager: SessionManager
  wsServer: WsRpcServer
  serverToken: string
  appUserDataPath: string
  argv?: string[]
  env?: NodeJS.ProcessEnv
  clock?: DiagnosticClock
}

class DiagnosticCounterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DiagnosticCounterError'
  }
}

class DiagnosticInvariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DiagnosticInvariantError'
  }
}

const realClock: DiagnosticClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise(resolveSleep => setTimeout(resolveSleep, ms)),
}

export function isMainMemoryDiagnosticEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MAIN_MEMORY_DIAGNOSTIC_GATE] === '1'
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    )
  }
  return value
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function hashIdentifier(kind: 'session' | 'client' | 'process', id: string): string {
  return sha256(`${MAIN_MEMORY_DIAGNOSTIC_PROTOCOL}:${kind}:${id}`)
}

/**
 * Conservative, content-free retained-byte estimate. Shared references are counted once,
 * getters are never invoked, and failure to traverse within the bound aborts the snapshot.
 */
export function estimateRetainedBytes(value: unknown, maxNodes = 500_000): number {
  const seen = new Set<object>()
  let visited = 0

  const visit = (current: unknown): number => {
    if (current === null || current === undefined) return 0
    switch (typeof current) {
      case 'boolean': return 4
      case 'number': return 8
      case 'bigint': return 8
      case 'string': return 16 + Buffer.byteLength(current, 'utf8')
      case 'symbol': return 8
      case 'function': return 16
      case 'object': break
      default: return 0
    }

    const object = current as object
    if (seen.has(object)) return 0
    seen.add(object)
    visited += 1
    if (visited > maxNodes) {
      throw new DiagnosticCounterError(`Retained-byte estimator exceeded ${maxNodes} objects`)
    }

    if (Buffer.isBuffer(object)) return 24 + object.byteLength
    if (ArrayBuffer.isView(object)) return 24 + object.byteLength
    if (object instanceof ArrayBuffer) return 24 + object.byteLength
    if (object instanceof Date) return 16
    if (Array.isArray(object)) return 24 + object.reduce((sum, item) => sum + visit(item), 0)
    if (object instanceof Map) {
      let total = 48
      for (const [key, nested] of object) total += 24 + visit(key) + visit(nested)
      return total
    }
    if (object instanceof Set) {
      let total = 48
      for (const nested of object) total += 16 + visit(nested)
      return total
    }

    let total = 32
    const descriptors = Object.getOwnPropertyDescriptors(object)
    for (const [key, descriptor] of Object.entries(descriptors)) {
      total += 16 + Buffer.byteLength(key, 'utf8')
      if ('value' in descriptor) total += visit(descriptor.value)
    }
    return total
  }

  const result = visit(value)
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new DiagnosticCounterError('Retained-byte estimator produced an invalid result')
  }
  return result
}

function asSessionManagerInternals(sessionManager: SessionManager): SessionManagerInternals {
  const internals = sessionManager as unknown as Partial<SessionManagerInternals>
  if (!(internals.sessions instanceof Map)) {
    throw new DiagnosticCounterError('SessionManager.sessions is unavailable')
  }
  if (!(internals.runtimeRegistry instanceof Map)) {
    throw new DiagnosticCounterError('SessionManager.runtimeRegistry is unavailable')
  }
  return internals as SessionManagerInternals
}

function asTransportInternals(wsServer: WsRpcServer): TransportInternals {
  const internals = wsServer as unknown as Partial<TransportInternals>
  if (!(internals.clients instanceof Map)) {
    throw new DiagnosticCounterError('WsRpcServer.clients is unavailable')
  }
  if (!(internals.disconnectedClients instanceof Map)) {
    throw new DiagnosticCounterError('WsRpcServer.disconnectedClients is unavailable')
  }
  return internals as TransportInternals
}

export function captureSessionManagerCounters(sessionManager: SessionManager): {
  transcripts: DiagnosticSessionCounters
  runtimes: DiagnosticRuntimeCounters
  background: DiagnosticBackgroundCounters
} {
  const internals = asSessionManagerInternals(sessionManager)
  const perSession: DiagnosticSessionCounters['perSession'] = []
  let totalMessages = 0
  let transcriptBytes = 0
  let taskRegistryCount = 0
  let taskRegistryRetainedBytesEstimate = 0
  let shellCommandCount = 0
  let shellCommandRetainedBytes = 0
  let taskOutputCount = 0
  let retainedOutputBytes = 0
  let taskOutputRetainedBytesEstimate = 0

  for (const managed of internals.sessions.values()) {
    if (typeof managed.id !== 'string' || typeof managed.messagesLoaded !== 'boolean') {
      throw new DiagnosticCounterError('Managed session identity/load state is unreadable')
    }
    if (!Array.isArray(managed.messages)) {
      throw new DiagnosticCounterError('Managed session messages are unreadable')
    }
    if (!(managed.backgroundTaskRegistry instanceof Map)
      || !(managed.backgroundShellCommands instanceof Map)
      || !(managed.backgroundTaskOutputs instanceof Map)) {
      throw new DiagnosticCounterError('Managed session background maps are unreadable')
    }

    if (managed.messagesLoaded) {
      const retainedBytesEstimate = estimateRetainedBytes(managed.messages)
      perSession.push({
        sessionHash: hashIdentifier('session', managed.id),
        messageCount: managed.messages.length,
        retainedBytesEstimate,
      })
      totalMessages += managed.messages.length
      transcriptBytes += retainedBytesEstimate
    }

    taskRegistryCount += managed.backgroundTaskRegistry.size
    taskRegistryRetainedBytesEstimate += estimateRetainedBytes(managed.backgroundTaskRegistry)
    shellCommandCount += managed.backgroundShellCommands.size
    for (const command of managed.backgroundShellCommands.values()) {
      if (typeof command !== 'string') throw new DiagnosticCounterError('Background shell command is unreadable')
      shellCommandRetainedBytes += Buffer.byteLength(command, 'utf8')
    }
    taskOutputCount += managed.backgroundTaskOutputs.size
    for (const output of managed.backgroundTaskOutputs.values()) {
      if (!output || typeof output.outputFile !== 'string' || typeof output.summary !== 'string') {
        throw new DiagnosticCounterError('Background task output is unreadable')
      }
      retainedOutputBytes += Buffer.byteLength(output.summary, 'utf8')
        + Buffer.byteLength(output.outputFile, 'utf8')
    }
    taskOutputRetainedBytesEstimate += estimateRetainedBytes(managed.backgroundTaskOutputs)
  }

  perSession.sort((a, b) => a.sessionHash.localeCompare(b.sessionHash))

  let liveGenerationCount = 0
  let runtimeBytes = 0
  for (const entry of internals.runtimeRegistry.values()) {
    if (!entry || !entry.managed || !entry.generation || typeof entry.generation !== 'object') {
      throw new DiagnosticCounterError('Runtime registry entry is unreadable')
    }
    if (entry.managed.runtimeGeneration === entry.generation) liveGenerationCount += 1
    runtimeBytes += estimateRetainedBytes(entry.generation)
  }

  return {
    transcripts: {
      loadedSessionCount: perSession.length,
      totalMessages,
      retainedBytesEstimate: transcriptBytes,
      perSession,
    },
    runtimes: {
      generationCount: internals.runtimeRegistry.size,
      liveGenerationCount,
      retainedBytesEstimate: runtimeBytes,
    },
    background: {
      taskRegistryCount,
      taskRegistryRetainedBytesEstimate,
      shellCommandCount,
      shellCommandRetainedBytes,
      taskOutputCount,
      retainedOutputBytes,
      taskOutputRetainedBytesEstimate,
    },
  }
}

export function captureTransportCounters(wsServer: WsRpcServer): DiagnosticTransportCounters {
  const internals = asTransportInternals(wsServer)
  const perClient: DiagnosticTransportCounters['perClient'] = []
  let totalEntryCount = 0
  let totalBytes = 0

  const captureClient = (client: DiagnosticTransportClient, state: 'connected' | 'disconnected') => {
    if (!client || typeof client.id !== 'string' || !Array.isArray(client.eventBuffer)) {
      throw new DiagnosticCounterError('Transport client buffer is unreadable')
    }
    let bytes = 0
    for (const entry of client.eventBuffer) {
      if (!entry || typeof entry.data !== 'string' || typeof entry.seq !== 'number') {
        throw new DiagnosticCounterError('Transport buffer entry is unreadable')
      }
      bytes += Buffer.byteLength(entry.data, 'utf8')
    }
    perClient.push({
      clientHash: hashIdentifier('client', client.id),
      state,
      entryCount: client.eventBuffer.length,
      bytes,
    })
    totalEntryCount += client.eventBuffer.length
    totalBytes += bytes
  }

  for (const client of internals.clients.values()) captureClient(client, 'connected')
  for (const entry of internals.disconnectedClients.values()) {
    if (!entry?.client) throw new DiagnosticCounterError('Disconnected transport client is unreadable')
    captureClient(entry.client, 'disconnected')
  }
  perClient.sort((a, b) => a.clientHash.localeCompare(b.clientHash))

  return {
    connectedClientCount: internals.clients.size,
    disconnectedClientCount: internals.disconnectedClients.size,
    totalEntryCount,
    totalBytes,
    perClient,
  }
}

async function readProcChildren(pid: number): Promise<number[]> {
  const text = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')
  return text.trim() ? text.trim().split(/\s+/).map(Number) : []
}

async function readPrivateBytes(pid: number): Promise<number | null> {
  try {
    const text = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8')
    let privateKiB = 0
    let found = false
    for (const line of text.split('\n')) {
      const match = /^(Private_(?:Clean|Dirty|Hugetlb)):\s+(\d+)\s+kB$/.exec(line)
      if (!match) continue
      privateKiB += Number(match[2])
      found = true
    }
    return found ? privateKiB * 1024 : null
  } catch {
    return null
  }
}

async function readPidRecord(pid: number): Promise<DiagnosticPidRecord> {
  const statText = await readFile(`/proc/${pid}/stat`, 'utf8')
  const closeParen = statText.lastIndexOf(')')
  if (closeParen < 0) throw new DiagnosticCounterError(`Malformed proc stat for descendant ${pid}`)
  const comm = statText.slice(statText.indexOf('(') + 1, closeParen)
  const fields = statText.slice(closeParen + 2).trim().split(/\s+/)
  const parentPid = Number(fields[1])
  const cpuUserTicks = Number(fields[11])
  const cpuSystemTicks = Number(fields[12])
  const rssPages = Number(fields[21])
  if (![parentPid, cpuUserTicks, cpuSystemTicks, rssPages].every(Number.isFinite)) {
    throw new DiagnosticCounterError(`Unreadable proc counters for descendant ${pid}`)
  }
  const privateBytes = await readPrivateBytes(pid)
  return {
    pid,
    parentPid,
    processNameHash: hashIdentifier('process', comm),
    rssBytes: rssPages * 4096,
    privateBytes,
    privateBytesAvailable: privateBytes !== null,
    cpuUserTicks,
    cpuSystemTicks,
  }
}

export async function capturePidTree(rootPid = process.pid): Promise<DiagnosticPidRecord[]> {
  if (process.platform !== 'linux') return []
  const queue = [rootPid]
  const seen = new Set<number>()
  const records: DiagnosticPidRecord[] = []

  while (queue.length > 0) {
    const pid = queue.shift()!
    if (seen.has(pid)) continue
    seen.add(pid)
    records.push(await readPidRecord(pid))
    for (const child of await readProcChildren(pid)) {
      if (Number.isInteger(child) && child > 0) queue.push(child)
    }
  }

  records.sort((a, b) => a.pid - b.pid)
  return records
}

export async function captureProcessCounters(): Promise<DiagnosticProcessCounters> {
  const memoryUsage = process.memoryUsage()
  const heapStatistics = getHeapStatistics()
  const pidTree = await capturePidTree()
  const main = pidTree.find(record => record.pid === process.pid)
  if (process.platform === 'linux' && !main) {
    throw new DiagnosticCounterError('Main PID is absent from its diagnostic PID tree')
  }
  if (process.platform === 'linux' && main?.privateBytes === null) {
    throw new DiagnosticCounterError('Main private RSS is unavailable on Linux')
  }
  const mainPrivateBytes = main?.privateBytes ?? null
  const accountedV8Bytes = memoryUsage.heapTotal + memoryUsage.external
  return {
    memoryUsage,
    heapStatistics,
    pidTree,
    pidTreeHash: sha256(canonicalJson(pidTree)),
    mainPrivateBytes,
    nativeResidualEstimate: {
      label: 'estimate-not-ownership-proof',
      formula: 'max(0, mainPrivateBytes - (heapTotal + external))',
      bytes: mainPrivateBytes === null ? null : Math.max(0, mainPrivateBytes - accountedV8Bytes),
    },
  }
}

export async function requestExplicitGc(gc: (() => void) | undefined = (globalThis as { gc?: () => void }).gc): Promise<ExplicitGcResult> {
  if (typeof gc !== 'function') {
    return { requested: true, available: false, completed: false }
  }
  gc()
  await new Promise<void>(resolveImmediate => setImmediate(resolveImmediate))
  gc()
  return { requested: true, available: true, completed: true }
}

export function createSyntheticFixturePlan(): SyntheticFixturePlan {
  const sessions = Array.from({ length: SYNTHETIC_SESSION_COUNT }, (_, index): SyntheticSessionPlanEntry => {
    const ordinal = index + 1
    const messageCount = 1_500 - index * 50
    const payloadBytesPerMessage = 4_096 - index * 128
    const sessionId = `diag-${String(ordinal).padStart(2, '0')}`
    return {
      ordinal,
      sessionId,
      sessionHash: hashIdentifier('session', sessionId),
      messageCount,
      payloadBytesPerMessage,
      logicalPayloadBytes: messageCount * payloadBytesPerMessage,
    }
  })
  for (let index = 1; index < sessions.length; index++) {
    if (sessions[index]!.logicalPayloadBytes >= sessions[index - 1]!.logicalPayloadBytes) {
      throw new DiagnosticInvariantError('Synthetic fixture plan is not strictly descending by size')
    }
  }
  const manifestBody = {
    generator: 'CRFT-MAIN-MEM-V1-SYNTHETIC-25' as const,
    version: 1 as const,
    sessions: sessions.map(({ ordinal, messageCount, payloadBytesPerMessage, logicalPayloadBytes }) => ({
      ordinal,
      messageCount,
      payloadBytesPerMessage,
      logicalPayloadBytes,
    })),
  }
  return { ...manifestBody, sessions, manifestHash: sha256(canonicalJson(manifestBody)) }
}

export function createWorkloadTraceManifest(): WorkloadTraceManifest {
  const body = {
    generator: 'CRFT-MAIN-MEM-V1-WORKLOAD' as const,
    version: 1 as const,
    tickMs: WORKLOAD_TICK_MS,
    ticks: WORKLOAD_TICK_COUNT,
    durationMs: WORKLOAD_DURATION_MS,
    textDeltaCount: WORKLOAD_TICK_COUNT,
    textDeltaBytes: WORKLOAD_TICK_COUNT * 32,
    toolResultCount: WORKLOAD_TICK_COUNT / 20,
    toolResultBytes: (WORKLOAD_TICK_COUNT / 20) * 2_048,
    backgroundTaskCount: WORKLOAD_TICK_COUNT / 200,
    transportEventCount: WORKLOAD_TICK_COUNT + WORKLOAD_TICK_COUNT / 20,
  }
  return { ...body, traceHash: sha256(canonicalJson(body)) }
}

function makeStoredMessages(entry: SyntheticSessionPlanEntry): StoredMessage[] {
  const payload = 'x'.repeat(entry.payloadBytesPerMessage)
  return Array.from({ length: entry.messageCount }, (_, index): StoredMessage => {
    const base = {
      id: `m-${String(entry.ordinal).padStart(2, '0')}-${String(index).padStart(4, '0')}`,
      content: payload,
      timestamp: 1_700_000_000_000 + entry.ordinal * 1_000_000 + index,
    }
    if (index % 15 === 0) return { ...base, type: 'user' }
    if (index % 3 === 0) {
      return {
        ...base,
        type: 'tool',
        toolName: `SyntheticTool${index % 10}`,
        toolUseId: `tool-${entry.ordinal}-${index}`,
        toolResult: payload,
        toolStatus: 'completed',
      }
    }
    return { ...base, type: 'assistant', isIntermediate: index % 5 !== 0 }
  })
}

export async function seedSyntheticSessions(workspaceRoot: string, plan = createSyntheticFixturePlan()): Promise<void> {
  const actualSizes: number[] = []
  for (const entry of plan.sessions) {
    const sessionFile = getSessionFilePath(workspaceRoot, entry.sessionId)
    await mkdir(dirname(sessionFile), { recursive: true })
    const storedSession: StoredSession = {
      id: entry.sessionId,
      workspaceRootPath: workspaceRoot,
      name: `Synthetic ${String(entry.ordinal).padStart(2, '0')}`,
      createdAt: 1_700_000_000_000 + entry.ordinal,
      lastUsedAt: 1_700_000_000_000 + entry.ordinal,
      messages: makeStoredMessages(entry),
      tokenUsage: ZERO_TOKEN_USAGE,
      enabledSourceSlugs: [],
      permissionMode: 'safe',
    }
    writeSessionJsonl(sessionFile, storedSession)
    actualSizes.push((await stat(sessionFile)).size)
  }
  for (let index = 1; index < actualSizes.length; index++) {
    if (actualSizes[index]! >= actualSizes[index - 1]!) {
      throw new DiagnosticInvariantError('Synthetic JSONL files are not strictly descending by byte size')
    }
  }
}

export async function executeDiagnosticProtocolSchedule(hooks: DiagnosticProtocolScheduleHooks): Promise<void> {
  let logicalElapsedMs = 0
  await hooks.clock.sleep(hooks.timing.baselineIdleMs)
  logicalElapsedMs += hooks.timing.baselineIdleMs
  await hooks.capture('baseline', logicalElapsedMs, true)

  for (let index = 0; index < SYNTHETIC_SESSION_COUNT; index++) {
    await hooks.openSession(index)
    await hooks.clock.sleep(hooks.timing.sessionOpenSpacingMs)
    logicalElapsedMs += hooks.timing.sessionOpenSpacingMs
    await hooks.capture(`open-${String(index + 1).padStart(2, '0')}`, logicalElapsedMs, false)
  }

  await hooks.capture('post-load', logicalElapsedMs, true)
  await hooks.runWorkload()
  logicalElapsedMs += hooks.timing.workloadDurationMs
  await hooks.capture('post-workload', logicalElapsedMs, false)
  await hooks.clock.sleep(hooks.timing.postWorkloadIdleMs)
  logicalElapsedMs += hooks.timing.postWorkloadIdleMs
  await hooks.capture('post-idle', logicalElapsedMs, true)
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]
  if (!value) throw new DiagnosticInvariantError(`Missing required diagnostic environment: ${key}`)
  return value
}

function assertChildPath(root: string, candidate: string, label: string): void {
  if (!isAbsolute(candidate)) throw new DiagnosticInvariantError(`${label} must be absolute`)
  const rel = relative(root, candidate)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new DiagnosticInvariantError(`${label} must be a distinct child of CRAFT_DIAG_ROOT`)
  }
}

export function validateDiagnosticIsolation(
  env: NodeJS.ProcessEnv,
  argv: string[],
  appUserDataPath: string,
): {
  mode: 'driver' | 'smoke'
  runId: string
  gitSha: string
  diagnosticRoot: string
  workspaceRoot: string
  sessionRoot: string
  outputDir: string
} {
  if (!isMainMemoryDiagnosticEnabled(env)) throw new DiagnosticInvariantError('Diagnostic gate is not enabled')
  const hasDriver = argv.includes(DIAGNOSTIC_DRIVER_ARG)
  const hasSmoke = argv.includes(DIAGNOSTIC_SMOKE_ARG)
  if (hasDriver === hasSmoke) {
    throw new DiagnosticInvariantError('Exactly one diagnostic mode argument is required')
  }
  if (env.CRAFT_HEADLESS !== '1') throw new DiagnosticInvariantError('CRAFT_HEADLESS=1 is required')
  if ((env.CRAFT_RPC_HOST ?? '127.0.0.1') !== '127.0.0.1') {
    throw new DiagnosticInvariantError('Diagnostic RPC host must be 127.0.0.1')
  }
  if ((env.CRAFT_RPC_PORT ?? '0') !== '0') {
    throw new DiagnosticInvariantError('Diagnostic RPC port must be 0')
  }

  const diagnosticRoot = resolve(requireEnv(env, 'CRAFT_DIAG_ROOT'))
  if (!diagnosticRoot.startsWith('/tmp/crft-main-mem-v1-m0d-')) {
    throw new DiagnosticInvariantError('CRAFT_DIAG_ROOT must use the dedicated /tmp/crft-main-mem-v1-m0d-* prefix')
  }
  const isolated = {
    HOME: resolve(requireEnv(env, 'HOME')),
    XDG_CONFIG_HOME: resolve(requireEnv(env, 'XDG_CONFIG_HOME')),
    XDG_CACHE_HOME: resolve(requireEnv(env, 'XDG_CACHE_HOME')),
    XDG_DATA_HOME: resolve(requireEnv(env, 'XDG_DATA_HOME')),
    CRAFT_CONFIG_DIR: resolve(requireEnv(env, 'CRAFT_CONFIG_DIR')),
    CRAFT_DIAG_SESSION_ROOT: resolve(requireEnv(env, 'CRAFT_DIAG_SESSION_ROOT')),
    CRAFT_DIAG_WORKSPACE_ROOT: resolve(requireEnv(env, 'CRAFT_DIAG_WORKSPACE_ROOT')),
    userData: resolve(appUserDataPath),
  }
  const values = Object.values(isolated)
  if (new Set(values).size !== values.length) {
    throw new DiagnosticInvariantError('All diagnostic profile/session/workspace roots must be distinct')
  }
  for (const [label, candidate] of Object.entries(isolated)) assertChildPath(diagnosticRoot, candidate, label)

  const outputDir = resolve(requireEnv(env, 'CRAFT_DIAG_OUTPUT_DIR'))
  const runId = requireEnv(env, 'CRAFT_DIAG_RUN_ID')
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(runId)) throw new DiagnosticInvariantError('Invalid diagnostic run id')
  const gitSha = requireEnv(env, 'CRAFT_DIAG_GIT_SHA')
  if (!/^[0-9a-f]{40}$/.test(gitSha)) throw new DiagnosticInvariantError('CRAFT_DIAG_GIT_SHA must be a full lowercase SHA')

  return {
    mode: hasDriver ? 'driver' : 'smoke',
    runId,
    gitSha,
    diagnosticRoot,
    workspaceRoot: isolated.CRAFT_DIAG_WORKSPACE_ROOT,
    sessionRoot: isolated.CRAFT_DIAG_SESSION_ROOT,
    outputDir,
  }
}

class JsonlDiagnosticWriter {
  private sequence = 0
  readonly outputFile: string

  constructor(
    outputDir: string,
    private readonly gitSha: string,
    private readonly runId: string,
    private readonly fixtureManifestHash: string,
    private readonly workloadTraceHash: string,
  ) {
    this.outputFile = join(outputDir, `crft-main-mem-v1-m0d-${runId}.jsonl`)
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.outputFile), { recursive: true })
    await writeFile(this.outputFile, '', { flag: 'wx', mode: 0o600 })
  }

  async write<T extends Omit<DiagnosticBaseRecord, 'schema' | 'version' | 'protocol' | 'gitSha' | 'runId' | 'sequence' | 'pid' | 'fixtureManifestHash' | 'workloadTraceHash'> & Record<string, unknown>>(
    payload: T,
  ): Promise<T & DiagnosticBaseRecord & { recordHash: string }> {
    const withoutHash: DiagnosticBaseRecord & T = {
      schema: MAIN_MEMORY_DIAGNOSTIC_SCHEMA,
      version: MAIN_MEMORY_DIAGNOSTIC_VERSION,
      protocol: MAIN_MEMORY_DIAGNOSTIC_PROTOCOL,
      gitSha: this.gitSha,
      runId: this.runId,
      sequence: ++this.sequence,
      pid: process.pid,
      fixtureManifestHash: this.fixtureManifestHash,
      workloadTraceHash: this.workloadTraceHash,
      ...payload,
    }
    const record = { ...withoutHash, recordHash: sha256(canonicalJson(withoutHash)) }
    await appendFile(this.outputFile, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
    return record
  }
}

async function captureAllCounters(sessionManager: SessionManager, wsServer: WsRpcServer): Promise<DiagnosticCounters> {
  const session = captureSessionManagerCounters(sessionManager)
  return {
    ...session,
    transport: captureTransportCounters(wsServer),
    process: await captureProcessCounters(),
  }
}

async function connectSyntheticReplayClient(
  wsServer: WsRpcServer,
  token: string,
  workspaceId: string,
): Promise<WebSocket> {
  return new Promise((resolveSocket, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${wsServer.port}`)
    const timeout = setTimeout(() => {
      socket.terminate()
      reject(new DiagnosticInvariantError('Synthetic replay client handshake timed out'))
    }, 5_000)
    socket.on('open', () => {
      socket.send(JSON.stringify({
        id: 'diag-handshake',
        type: 'handshake',
        protocolVersion: PROTOCOL_VERSION,
        token,
        workspaceId,
      }))
    })
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString()) as { type?: string }
      if (message.type !== 'handshake_ack') return
      clearTimeout(timeout)
      resolveSocket(socket)
    })
    socket.on('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

async function closeSocket(socket: WebSocket | null): Promise<void> {
  if (!socket || socket.readyState === WebSocket.CLOSED) return
  await new Promise<void>(resolveClose => {
    const timeout = setTimeout(() => {
      socket.terminate()
      resolveClose()
    }, 1_000)
    socket.once('close', () => {
      clearTimeout(timeout)
      resolveClose()
    })
    socket.close()
  })
}

function appendSyntheticWorkloadState(
  sessionManager: SessionManager,
  sessionId: string,
  tick: number,
): { toolEvent: boolean } {
  const managed = asSessionManagerInternals(sessionManager).sessions.get(sessionId)
  if (!managed || !managed.messagesLoaded) {
    throw new DiagnosticInvariantError('Synthetic workload target is not loaded')
  }
  let stream = managed.messages.find(message => message.id === 'diag-workload-stream')
  if (!stream) {
    stream = {
      id: 'diag-workload-stream',
      role: 'assistant',
      content: '',
      timestamp: 1_800_000_000_000,
      isStreaming: true,
    }
    managed.messages.push(stream)
  }
  stream.content += 'd'.repeat(32)

  const toolEvent = tick % 20 === 0
  if (toolEvent) {
    const toolOrdinal = tick / 20
    managed.messages.push({
      id: `diag-workload-tool-${toolOrdinal}`,
      role: 'tool',
      content: '',
      timestamp: 1_800_000_000_000 + tick,
      toolName: `SyntheticTool${toolOrdinal % 10}`,
      toolUseId: `diag-tool-${toolOrdinal}`,
      toolResult: 't'.repeat(2_048),
      toolStatus: 'completed',
    })
  }

  if (tick % 200 === 0) {
    const taskOrdinal = tick / 200
    const taskId = `diag-background-${taskOrdinal}`
    managed.backgroundTaskRegistry.set(taskId, {
      taskId,
      intent: `synthetic-${taskOrdinal}`,
      startTime: 1_800_000_000_000 + tick,
      status: 'completed',
      completedAt: 1_800_000_000_000 + tick,
    })
    managed.backgroundShellCommands.set(`diag-shell-${taskOrdinal}`, `printf synthetic-${taskOrdinal}`)
    managed.backgroundTaskOutputs.set(taskId, {
      outputFile: `diag-output-${taskOrdinal}.txt`,
      summary: 's'.repeat(512),
      status: 'completed',
      completedAt: 1_800_000_000_000 + tick,
    })
  }
  return { toolEvent }
}

async function runSyntheticWorkload(
  sessionManager: SessionManager,
  wsServer: WsRpcServer,
  workspaceId: string,
  sessionId: string,
  clock: DiagnosticClock,
): Promise<void> {
  for (let tick = 1; tick <= WORKLOAD_TICK_COUNT; tick++) {
    await clock.sleep(WORKLOAD_TICK_MS)
    const { toolEvent } = appendSyntheticWorkloadState(sessionManager, sessionId, tick)
    wsServer.push('diag:synthetic-stream', { to: 'workspace', workspaceId }, {
      type: 'text_delta',
      sequence: tick,
      bytes: 32,
    })
    if (toolEvent) {
      wsServer.push('diag:synthetic-tool', { to: 'workspace', workspaceId }, {
        type: 'tool_complete',
        sequence: tick / 20,
        bytes: 2_048,
      })
    }
  }
  const managed = asSessionManagerInternals(sessionManager).sessions.get(sessionId)
  const stream = managed?.messages.find(message => message.id === 'diag-workload-stream')
  if (stream) stream.isStreaming = false
}

async function removeUnexpectedSyntheticState(workspaceRoot: string): Promise<void> {
  const sessionsDir = join(workspaceRoot, 'sessions')
  try {
    for (const entry of await readdir(sessionsDir, { withFileTypes: true })) {
      if (!entry.name.startsWith('diag-')) {
        throw new DiagnosticInvariantError('Non-synthetic session found in isolated workspace')
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function validateSessionManagerWorkspace(sessionManager: SessionManager, workspaceRoot: string): { id: string; rootPath: string } {
  const workspaces = sessionManager.getWorkspaces()
  if (workspaces.length !== 1) throw new DiagnosticInvariantError('Diagnostic instance must expose exactly one workspace')
  const workspace = workspaces[0]!
  if (resolve(workspace.rootPath) !== resolve(workspaceRoot)) {
    throw new DiagnosticInvariantError('SessionManager workspace escaped the isolated diagnostic root')
  }
  return { id: workspace.id, rootPath: workspace.rootPath }
}

export async function runMainMemoryDiagnostic(context: MainMemoryDiagnosticContext): Promise<{ outputFile: string; mode: 'driver' | 'smoke' }> {
  const env = context.env ?? process.env
  const argv = context.argv ?? process.argv
  const isolation = validateDiagnosticIsolation(env, argv, context.appUserDataPath)
  const clock = context.clock ?? realClock
  const fixture = createSyntheticFixturePlan()
  const workload = createWorkloadTraceManifest()
  const writer = new JsonlDiagnosticWriter(
    isolation.outputDir,
    isolation.gitSha,
    isolation.runId,
    fixture.manifestHash,
    workload.traceHash,
  )
  await writer.initialize()
  const workspace = validateSessionManagerWorkspace(context.sessionManager, isolation.workspaceRoot)
  await removeUnexpectedSyntheticState(workspace.rootPath)
  const startedAt = clock.now()
  let currentStage: DiagnosticStage = isolation.mode === 'smoke' ? 'smoke' : 'baseline'
  let sampleTimer: ReturnType<typeof setInterval> | undefined
  let sampling = false
  let syntheticClient: WebSocket | null = null

  const writeSnapshot = async (
    kind: 'snapshot' | 'sample',
    stage: DiagnosticStage,
    logicalElapsedMs: number,
    gcCheckpoint: boolean,
  ) => {
    const gc = gcCheckpoint
      ? await requestExplicitGc()
      : { requested: false, available: typeof (globalThis as { gc?: unknown }).gc === 'function', completed: false }
    const counters = await captureAllCounters(context.sessionManager, context.wsServer)
    await writer.write({
      kind,
      stage,
      timestamp: new Date(clock.now()).toISOString(),
      logicalElapsedMs,
      gc,
      counters,
    })
  }

  await writer.write({
    kind: 'run-start',
    stage: currentStage,
    status: 'running',
    timestamp: new Date(startedAt).toISOString(),
    logicalElapsedMs: 0,
  } satisfies Omit<DiagnosticLifecycleRecord, keyof DiagnosticBaseRecord | 'recordHash'> & Record<string, unknown>)

  try {
    if (isolation.mode === 'smoke') {
      await writeSnapshot('snapshot', 'smoke', 0, true)
    } else {
      await seedSyntheticSessions(workspace.rootPath, fixture)
      context.sessionManager.reloadSessions()
      const orderedSessions = fixture.sessions
      const known = new Set(context.sessionManager.getSessions(workspace.id).map(session => session.id))
      if (known.size !== SYNTHETIC_SESSION_COUNT || orderedSessions.some(entry => !known.has(entry.sessionId))) {
        throw new DiagnosticInvariantError('SessionManager did not register exactly 25 synthetic sessions')
      }
      syntheticClient = await connectSyntheticReplayClient(context.wsServer, context.serverToken, workspace.id)

      sampleTimer = setInterval(() => {
        if (sampling) return
        sampling = true
        const logicalElapsedMs = Math.max(0, clock.now() - startedAt)
        void writeSnapshot('sample', currentStage, logicalElapsedMs, false)
          .catch(() => {
            // Stage snapshots fail closed. Sampling errors are surfaced by the next required snapshot.
          })
          .finally(() => { sampling = false })
      }, SAMPLE_INTERVAL_MS)
      sampleTimer.unref?.()

      await executeDiagnosticProtocolSchedule({
        clock,
        timing: {
          baselineIdleMs: BASELINE_IDLE_MS,
          sessionOpenSpacingMs: SESSION_OPEN_SPACING_MS,
          workloadDurationMs: WORKLOAD_DURATION_MS,
          postWorkloadIdleMs: POST_WORKLOAD_IDLE_MS,
        },
        openSession: async index => {
          const expected = orderedSessions[index]!
          const loaded = await context.sessionManager.getSession(expected.sessionId)
          if (!loaded || loaded.messages.length !== expected.messageCount) {
            throw new DiagnosticInvariantError(`Synthetic session ${index + 1} failed deterministic load validation`)
          }
        },
        runWorkload: async () => {
          currentStage = 'post-workload'
          await runSyntheticWorkload(
            context.sessionManager,
            context.wsServer,
            workspace.id,
            orderedSessions[0]!.sessionId,
            clock,
          )
        },
        capture: async (stage, logicalElapsedMs, gcCheckpoint) => {
          currentStage = stage
          await writeSnapshot('snapshot', stage, logicalElapsedMs, gcCheckpoint)
        },
      })
    }

    await writer.write({
      kind: 'run-complete',
      stage: currentStage,
      status: 'complete',
      timestamp: new Date(clock.now()).toISOString(),
      logicalElapsedMs: Math.max(0, clock.now() - startedAt),
    } satisfies Omit<DiagnosticLifecycleRecord, keyof DiagnosticBaseRecord | 'recordHash'> & Record<string, unknown>)
  } catch (error) {
    await writer.write({
      kind: 'run-error',
      stage: currentStage,
      status: 'error',
      errorCode: error instanceof Error ? error.name : 'UnknownError',
      timestamp: new Date(clock.now()).toISOString(),
      logicalElapsedMs: Math.max(0, clock.now() - startedAt),
    } satisfies Omit<DiagnosticLifecycleRecord, keyof DiagnosticBaseRecord | 'recordHash'> & Record<string, unknown>)
    throw error
  } finally {
    if (sampleTimer) clearInterval(sampleTimer)
    await closeSocket(syntheticClient)
  }

  return { outputFile: writer.outputFile, mode: isolation.mode }
}

/** Test-only helper for cleaning fixture roots created outside the production launcher. */
export async function removeSyntheticFixtureRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true })
}
