/**
 * oracle.ts — canonical hashing of message/grouping state for CRFT-STREAM-V1.
 *
 * The oracle records the expected `groupMessagesByTurn` output hash and the
 * ordered-message hash after every semantic barrier in the trace, plus the final
 * transcript hash. T0 replays the same trace and compares against these hashes;
 * visual observation alone cannot satisfy zero-loss correctness.
 *
 * Content is hashed via per-string SHA-256 digests (cached) so that delta content
 * changes are detected while the total hashing cost stays bounded.
 */
import type { Message } from '@craft-agent/core'
import { groupMessagesByTurn } from '../../components/chat/turn-utils'
import type { ActivityItem, AssistantTurn, Turn } from '../../components/chat/turn-utils'
import { sha256 } from '../sha256'
import { applyTraceEvent } from './reducer'
import * as C from './constants'
import type { CrftStreamFixture, CrftStreamOracle, OracleBarrier, TraceEvent } from './types'

// Cache content digests by exact string. Base-fixture content is stable across
// barriers, so this collapses repeated hashing to the first occurrence.
const digestCache = new Map<string, string>()
function digest(s: string | undefined): string {
  if (!s) return 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' // sha256("")
  let d = digestCache.get(s)
  if (d === undefined) {
    d = sha256(s)
    digestCache.set(s, d)
  }
  return d
}

/** Is the session logically "processing" for grouping purposes? */
function isProcessing(messages: Message[]): boolean {
  return messages.some((m) => m.isStreaming === true || m.isPending === true)
}

// ---------------------------------------------------------------------------
// Canonical serializers (bounded, deterministic)
// ---------------------------------------------------------------------------

function canonicalMessage(m: Message): string {
  // Ordered, fixed-field tuple. Content collapsed to a digest.
  return [
    m.id,
    m.role,
    m.timestamp,
    digest(m.content),
    m.isStreaming ? 1 : 0,
    m.isPending ? 1 : 0,
    m.isIntermediate ? 1 : 0,
    m.toolStatus ?? '',
    m.statusType ?? '',
    m.toolResult ? digest(m.toolResult) : '',
    m.annotations ? m.annotations.length : 0,
    m.parentToolUseId ?? '',
  ].join('')
}

function canonicalActivity(a: ActivityItem): string {
  return [
    a.id,
    a.type,
    a.status,
    a.timestamp,
    a.depth ?? 0,
    a.toolName ?? '',
    a.toolUseId ?? '',
    a.parentId ?? '',
    a.statusType ?? '',
    a.content ? digest(a.content) : '',
    a.annotations ? a.annotations.length : 0,
  ].join('')
}

function canonicalTurn(t: Turn): string {
  if (t.type === 'assistant') {
    const at = t as AssistantTurn
    const acts = at.activities.map(canonicalActivity).join('')
    const resp = at.response
      ? [at.response.messageId ?? '', at.response.isStreaming ? 1 : 0, digest(at.response.text), at.response.annotations?.length ?? 0].join('')
      : ''
    const todos = at.todos ? at.todos.map((td) => `${td.status}:${digest(td.content)}`).join(',') : ''
    return ['assistant', at.turnId, at.timestamp, at.isStreaming ? 1 : 0, at.isComplete ? 1 : 0, acts, resp, todos].join('')
  }
  return [t.type, t.message.id, t.timestamp, t.message.role].join('')
}

// ---------------------------------------------------------------------------
// Public hashing helpers
// ---------------------------------------------------------------------------

/** Hash of the visible (non-hidden), stable-sorted ordered message stream. */
export function hashOrderedMessages(messages: Message[]): string {
  const visible = messages.filter((m) => !m.hidden)
  const sorted = visible
    .map((m, i) => ({ m, i }))
    .sort((a, b) => (a.m.timestamp - b.m.timestamp) || (a.i - b.i)) // stable
    .map((x) => x.m)
  return sha256(sorted.map(canonicalMessage).join('\n'))
}

/** Hash of the canonical `groupMessagesByTurn` output. */
export function hashGrouping(messages: Message[]): string {
  const turns = groupMessagesByTurn(messages, { isSessionProcessing: isProcessing(messages) })
  return sha256(turns.map(canonicalTurn).join('\n'))
}

/** Hash of the full transcript (all messages incl. hidden, in array order). */
export function hashTranscript(messages: Message[]): string {
  return sha256(messages.map(canonicalMessage).join('\n'))
}

// ---------------------------------------------------------------------------
// Oracle computation
// ---------------------------------------------------------------------------

/** Walk the trace, applying events and recording hashes at each barrier. */
export function computeOracle(fixture: CrftStreamFixture): CrftStreamOracle {
  let messages = fixture.messages
  const baseOrderedMessagesHash = hashOrderedMessages(messages)
  const baseGroupingHash = hashGrouping(messages)

  const barriers: OracleBarrier[] = []
  for (const event of fixture.trace) {
    messages = applyTraceEvent(messages, event)
    if (event.barrier) {
      barriers.push({
        seq: event.seq,
        label: event.label ?? `seq-${event.seq}`,
        orderedMessagesHash: hashOrderedMessages(messages),
        groupingHash: hashGrouping(messages),
      })
    }
  }

  return {
    generatorId: C.GENERATOR_ID,
    generatorVersion: C.GENERATOR_VERSION,
    seed: C.SEED,
    baseGroupingHash,
    baseOrderedMessagesHash,
    barriers,
    finalOrderedMessagesHash: hashOrderedMessages(messages),
    finalGroupingHash: hashGrouping(messages),
    finalTranscriptHash: hashTranscript(messages),
  }
}

// ---------------------------------------------------------------------------
// Replay validation (for live harnesses, e.g. the Lane A UI harness)
// ---------------------------------------------------------------------------

export interface ReplayValidationResult {
  pass: boolean
  mismatches: string[]
  groupingHash: string
  transcriptHash: string
}

/**
 * Validates `liveMessages` — the state a harness actually produced by applying
 * `events` incrementally (e.g. one-event-per-render, via its own UI loop) —
 * against an independent pure-fold replay of the same events over the same
 * base fixture. When `events` is the full, uncapped `fixture.trace`, this also
 * checks against the frozen R0 baseline (`expectedOracle`).
 *
 * This is the check that actually catches replay/reducer regressions: calling
 * `computeOracle(fixture)` fresh and comparing it to another `computeOracle(fixture)`
 * call compares two invocations of the same pure function on the same frozen
 * input, so it always matches regardless of what `liveMessages` contains and
 * regardless of whether `events` was capped (e.g. via a deltaLimit param).
 */
export function validateReplay(
  fixture: CrftStreamFixture,
  events: TraceEvent[],
  liveMessages: Message[],
  expectedOracle: CrftStreamOracle,
): ReplayValidationResult {
  const independentReplay = events.reduce((acc, e) => applyTraceEvent(acc, e), fixture.messages)
  const groupingHash = hashGrouping(liveMessages)
  const transcriptHash = hashTranscript(liveMessages)
  const expectedGroupingHash = hashGrouping(independentReplay)
  const expectedTranscriptHash = hashTranscript(independentReplay)

  const mismatches: string[] = []
  if (groupingHash !== expectedGroupingHash) mismatches.push('groupingHash')
  if (transcriptHash !== expectedTranscriptHash) mismatches.push('transcriptHash')

  // Only compare against the frozen full-trace baseline when nothing was
  // actually capped/dropped — a partial (deltaLimit-capped) run cannot match
  // the full-trace final hashes by construction.
  if (events.length === fixture.trace.length) {
    if (groupingHash !== expectedOracle.finalGroupingHash) mismatches.push('finalGroupingHash')
    if (transcriptHash !== expectedOracle.finalTranscriptHash) mismatches.push('finalTranscriptHash')
  }

  return { pass: mismatches.length === 0, mismatches, groupingHash, transcriptHash }
}
