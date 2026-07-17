/**
 * generator.ts — deterministic construction of the CRFT-STREAM-V1 base fixture
 * and its replay trace.
 *
 * Everything here is a pure function of the frozen constants in `constants.ts`.
 * There is no Date.now, no Math.random, and no environment input, so the same
 * code produces byte-identical output (and therefore identical SHA-256 hashes)
 * everywhere it runs: bun scripts, `bun test`, and the browser harness.
 *
 * Base fixture layout (exactly 1,500 messages):
 *   - 100 user boundary messages         (one per turn)
 *   - 900 tool messages                  (10 tools × 90 tool-heavy turns)
 *   - 300 intermediate assistant messages(3 per turn)
 *   - 100 final assistant messages        (one per turn)
 *   - 100 special messages                (status/info/warning/error/plan/auth/
 *                                          hidden + compaction-complete pairs)
 */
import type { AnnotationV1, Message, ToolDisplayMeta } from '@craft-agent/core'
import * as C from './constants'
import type { CrftStreamFixture, TraceEvent } from './types'

const SESSION_ID = 'crft-stream-v1'

// ---------------------------------------------------------------------------
// Deterministic ASCII filler (1 byte === 1 char, so char length === byte length)
// ---------------------------------------------------------------------------

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,'
const BLOCK = (() => {
  let s = ''
  for (let i = 0; i < 256; i++) s += ALPHABET[i % ALPHABET.length]
  return s
})()

function saltRotation(salt: string): number {
  let h = 0
  for (let i = 0; i < salt.length; i++) h = (h * 31 + salt.charCodeAt(i)) >>> 0
  return h % BLOCK.length
}

/** Deterministic ASCII string of exactly `bytes` bytes, varied by `salt`. */
function filler(bytes: number, salt: string): string {
  if (bytes <= 0) return ''
  const rot = saltRotation(salt)
  const rotated = BLOCK.slice(rot) + BLOCK.slice(0, rot)
  const repeats = Math.ceil(bytes / rotated.length)
  return rotated.repeat(repeats).slice(0, bytes)
}

// ---------------------------------------------------------------------------
// Annotation factory (content-free structural annotation)
// ---------------------------------------------------------------------------

function makeAnnotation(messageId: string, idx: number): AnnotationV1 {
  return {
    id: `ann-${messageId}-${idx}`,
    schemaVersion: 1,
    createdAt: C.TIME_ORIGIN_MS + idx * 1000,
    body: [{ type: 'note', text: `note-${idx}`, format: 'plain' }],
    target: {
      source: { sessionId: SESSION_ID, messageId },
      selectors: [{ type: 'block', blockType: 'paragraph', path: `/0/${idx}` }],
    },
    intent: 'comment',
    status: 'pending',
    style: { color: 'yellow' },
  }
}

// ---------------------------------------------------------------------------
// Tool payload size + icon schedule (deterministic, disjoint)
// ---------------------------------------------------------------------------

/** Global tool indices (0..899) that receive the 192 KiB payload. */
const BIG_192_INDICES = new Set([55, 255, 455, 655, 855])
/** Predicate for the 45 tool indices that receive the 32 KiB payload. */
function is32KiB(globalToolIndex: number): boolean {
  return globalToolIndex % 20 === 10 // 10,30,...,890 → 45 indices, disjoint from BIG_192
}

function toolPayloadBytes(globalToolIndex: number): number {
  if (BIG_192_INDICES.has(globalToolIndex)) return C.TOOL_PAYLOAD_192KIB
  if (is32KiB(globalToolIndex)) return C.TOOL_PAYLOAD_32KIB
  return C.TOOL_PAYLOAD_2KIB
}

function toolIcon(globalToolIndex: number): ToolDisplayMeta {
  const icon = C.ICON_IDENTITIES[globalToolIndex % C.ICON_IDENTITIES.length]!
  return {
    displayName: icon.displayName,
    iconDataUrl: icon.iconDataUrl,
    description: `Icon identity ${icon.id}`,
    category: icon.category,
  }
}

// ---------------------------------------------------------------------------
// Special-message scheduling (exactly 100 special messages)
// ---------------------------------------------------------------------------

type SpecialRole = 'hidden' | 'warning' | 'error' | 'auth' | 'plan' | 'info' | 'compaction'

/** Forced late-turn assignments so the last visible turns cover every case. */
const FORCED: Record<number, SpecialRole> = {
  90: 'plan',
  91: 'warning',
  92: 'error',
  93: 'compaction',
  94: 'hidden',
  96: 'auth',
}
/** Turns intentionally left free of specials (plain-response cases in the tail). */
const NO_SPECIAL = new Set<number>([95, 97, 98, 99])

/**
 * Deterministically assign one special role to a set of turns so that the total
 * special MESSAGE count is exactly 100 (compaction assigns 2 messages per turn).
 */
function buildSpecialSchedule(): Map<number, SpecialRole> {
  const schedule = new Map<number, SpecialRole>()
  // Remaining budget after the forced assignments below.
  const budget: Record<SpecialRole, number> = {
    hidden: 19, warning: 14, error: 14, auth: 14, plan: 14, info: 8, compaction: 5,
  }
  for (const [turnStr, role] of Object.entries(FORCED)) {
    schedule.set(Number(turnStr), role)
  }
  // Flatten remaining budget into a fixed-order role queue.
  const order: SpecialRole[] = ['hidden', 'warning', 'error', 'auth', 'plan', 'info', 'compaction']
  const queue: SpecialRole[] = []
  for (const role of order) {
    for (let i = 0; i < budget[role]; i++) queue.push(role)
  }
  // Drain the queue across the early turns (0..89) in order.
  let qi = 0
  for (let turn = 0; turn < 100 && qi < queue.length; turn++) {
    if (FORCED[turn] !== undefined || NO_SPECIAL.has(turn)) continue
    schedule.set(turn, queue[qi]!)
    qi++
  }
  return schedule
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

/** Turns that carry annotation-bearing final assistant responses. */
const ANNOTATION_TURNS = new Set<number>([12, 47, 88, 95, 99])

export function generateCrftStreamV1(): CrftStreamFixture {
  const specials = buildSpecialSchedule()

  // Build message specs in final display order; timestamps assigned afterwards.
  const msgs: Message[] = []
  const tie: boolean[] = []
  const push = (m: Message, tieWithPrev = false) => {
    msgs.push(m)
    tie.push(tieWithPrev)
  }

  let globalToolIndex = 0

  for (let turn = 0; turn < C.TURN_COUNT; turn++) {
    const special = specials.get(turn)
    const isToolHeavy = turn < C.TOOL_HEAVY_TURN_COUNT

    // --- Standalone specials emitted BEFORE the user boundary ------------
    if (special === 'hidden') {
      push({ id: `h${turn}`, role: 'info', content: `hidden nudge ${turn}`, timestamp: 0, hidden: true })
    } else if (special === 'warning') {
      push({ id: `warn${turn}`, role: 'warning', content: `warning ${turn}: ${filler(64, `w${turn}`)}`, timestamp: 0, infoLevel: 'warning' })
    } else if (special === 'error') {
      push({ id: `err${turn}`, role: 'error', content: `error ${turn}`, timestamp: 0, infoLevel: 'error', errorCode: 'demo_error', errorTitle: 'Demo error' })
    } else if (special === 'auth') {
      push({ id: `auth${turn}`, role: 'auth-request', content: `auth ${turn}`, timestamp: 0, authRequestId: `authreq-${turn}`, authRequestType: 'credential', authSourceSlug: 'demo', authSourceName: 'Demo Source', authStatus: 'pending', authCredentialMode: 'bearer' })
    } else if (special === 'info') {
      push({ id: `info${turn}`, role: 'info', content: `info ${turn}`, timestamp: 0, infoLevel: 'info' })
    } else if (special === 'plan') {
      const planId = `plan${turn}`
      const annotated = turn % 2 === 0
      push({
        id: planId,
        role: 'plan',
        content: `# Plan ${turn}\n\n${filler(128, `p${turn}`)}`,
        timestamp: 0,
        planPath: `/plans/plan-${turn}.md`,
        annotations: annotated ? [makeAnnotation(planId, turn)] : undefined,
      })
    }

    // --- User boundary ---------------------------------------------------
    push({ id: `u${turn}`, role: 'user', content: `User request ${turn}: ${filler(48, `u${turn}`)}`, timestamp: 0 })

    // --- Compaction pair (status + compaction_complete) ------------------
    if (special === 'compaction') {
      push({ id: `st${turn}`, role: 'status', content: `Compacting conversation ${turn}...`, timestamp: 0, statusType: 'compacting' })
      push({ id: `cc${turn}`, role: 'info', content: `Compaction complete ${turn}`, timestamp: 0, statusType: 'compaction_complete' })
    }

    // --- Tools (tool-heavy turns) ---------------------------------------
    if (isToolHeavy) {
      for (let k = 0; k < C.TOOLS_PER_TOOL_HEAVY_TURN; k++) {
        const gti = globalToolIndex++
        const bytes = toolPayloadBytes(gti)
        const toolName = C.TOOL_NAMES[k % C.TOOL_NAMES.length]!
        const toolUseId = `tu-${turn}-${k}`
        // Turn 89: exercise a parent/child Task pair and an equal-timestamp tie.
        const isParentTask = turn === 89 && k === 0
        const isChildOfTask = turn === 89 && k === 1
        const tieWithPrev = turn === 89 && k === 3 // tool 3 ties with tool 2
        push(
          {
            id: `t${turn}-${k}`,
            role: 'tool',
            content: `tool ${toolName}`,
            timestamp: 0,
            toolName: isParentTask ? 'Task' : toolName,
            toolUseId,
            toolInput: isParentTask
              ? { description: `Subtask ${turn}`, subagent_type: 'Explore' }
              : { arg: `v${turn}-${k}` },
            toolResult: filler(bytes, `tr-${turn}-${k}`),
            toolStatus: 'completed',
            toolDisplayMeta: toolIcon(gti),
            parentToolUseId: isChildOfTask ? `tu-89-0` : undefined,
          },
          tieWithPrev,
        )
      }
    }

    // --- Intermediate assistant messages --------------------------------
    for (let k = 0; k < C.INTERMEDIATE_PER_TURN; k++) {
      push({ id: `i${turn}-${k}`, role: 'assistant', content: `Intermediate ${turn}.${k}: ${filler(80, `i${turn}-${k}`)}`, timestamp: 0, isIntermediate: true })
    }

    // --- Final assistant response ---------------------------------------
    const finalId = `a${turn}`
    push({
      id: finalId,
      role: 'assistant',
      content: `Final response ${turn}: ${filler(160, `a${turn}`)}`,
      timestamp: 0,
      annotations: ANNOTATION_TURNS.has(turn) ? [makeAnnotation(finalId, turn)] : undefined,
    })
  }

  // --- Assign monotonic timestamps (with deliberate ties) ---------------
  let idx = 0
  for (let i = 0; i < msgs.length; i++) {
    if (tie[i] && i > 0) {
      msgs[i]!.timestamp = msgs[i - 1]!.timestamp
    } else {
      msgs[i]!.timestamp = C.TIME_ORIGIN_MS + idx * C.TIME_STEP_MS
      idx++
    }
  }

  const trace = buildTrace(C.TIME_ORIGIN_MS + (idx + 10) * C.TIME_STEP_MS, msgs)

  return { messages: msgs, trace }
}

// ---------------------------------------------------------------------------
// Trace builder
// ---------------------------------------------------------------------------

/**
 * Build the replay trace. Timestamps continue past the base fixture. The trace
 * exercises: a streaming temporary message promoted to an authoritative id whose
 * timestamp moves its stable-sort position across a boundary, a second active
 * turn, late tool completion, annotation update, compaction completion,
 * interruption filtering, hidden insert/remove, and a full-session replacement.
 */
function buildTrace(startTs: number, baseMessages: Message[]): TraceEvent[] {
  const events: TraceEvent[] = []
  let seq = 0
  let ts = startTs
  const nextTs = () => (ts += C.TIME_STEP_MS)

  const primaryContent = filler(C.PRIMARY_DELTA_COUNT * C.DELTA_BYTES, 'final-1')
  const secondaryContent = filler(C.SECONDARY_DELTA_COUNT * C.DELTA_BYTES, 'final-2')

  // 1) Stream start for a temporary renderer message (preceded by a user turn).
  const tempId = 'tmp-active-1'
  const userTs1 = nextTs()
  events.push({
    kind: 'stream_start',
    seq: seq++,
    label: 'primary-stream-start',
    barrier: true,
    userMessageId: 'u-trace-1',
    userTimestamp: userTs1,
    userContent: 'Trace user boundary 1',
    messageId: tempId,
    timestamp: nextTs(),
    turnId: 'turn-trace-1',
  })

  // 2) 1,200 already-main-batched text_delta events, 32 bytes each.
  for (let i = 0; i < C.PRIMARY_DELTA_COUNT; i++) {
    events.push({
      kind: 'text_delta',
      seq: seq++,
      messageId: tempId,
      chunk: filler(C.DELTA_BYTES, `d1-${i}`),
      // Record a barrier every 300 deltas to bound the oracle size.
      barrier: (i + 1) % 300 === 0,
      label: (i + 1) % 300 === 0 ? `primary-delta-${i + 1}` : undefined,
    })
  }

  // 3) text_complete: authoritative id + a timestamp that moves the message's
  //    stable-sort position BEFORE the trace user boundary (crosses a boundary).
  const authId = 'a-active-1'
  events.push({
    kind: 'text_complete',
    seq: seq++,
    label: 'primary-text-complete',
    barrier: true,
    tempMessageId: tempId,
    messageId: authId,
    // Deliberately earlier than the temp start timestamp to force a reorder.
    timestamp: startTs - C.TIME_STEP_MS,
    content: primaryContent,
    isIntermediate: false,
  })

  // 4) New user boundary + second active turn with 200 deltas.
  const temp2 = 'tmp-active-2'
  const auth2Id = 'a-active-2'
  const userTs2 = nextTs()
  events.push({
    kind: 'user_boundary',
    seq: seq++,
    label: 'secondary-user-boundary',
    barrier: true,
    messageId: 'u-trace-2',
    timestamp: userTs2,
    content: 'Trace user boundary 2',
  })
  events.push({
    kind: 'stream_start',
    seq: seq++,
    label: 'secondary-stream-start',
    messageId: temp2,
    timestamp: nextTs(),
    turnId: 'turn-trace-2',
  })
  for (let i = 0; i < C.SECONDARY_DELTA_COUNT; i++) {
    events.push({
      kind: 'text_delta',
      seq: seq++,
      messageId: temp2,
      chunk: filler(C.DELTA_BYTES, `d2-${i}`),
      barrier: (i + 1) % 200 === 0,
      label: (i + 1) % 200 === 0 ? `secondary-delta-${i + 1}` : undefined,
    })
  }

  // 5) Deterministic late subtraces.
  // 5a) Late tool completion (turn 89's parent Task result finalizes).
  events.push({
    kind: 'tool_late_complete',
    seq: seq++,
    label: 'late-tool-complete',
    barrier: true,
    messageId: 't89-0',
    toolResult: filler(C.TOOL_PAYLOAD_2KIB, 'late-tool-89-0'),
  })
  // 5b) Annotation update on an existing final response.
  events.push({
    kind: 'annotation_update',
    seq: seq++,
    label: 'annotation-update',
    barrier: true,
    messageId: 'a95',
    annotations: [makeAnnotation('a95', 999)],
  })
  // 5c) Compaction completion for the second active turn.
  events.push({
    kind: 'compaction_complete',
    seq: seq++,
    label: 'trace-compaction-complete',
    barrier: true,
    messageId: 'cc-trace-1',
    timestamp: nextTs(),
    content: 'Trace compaction complete',
  })
  // 5d) Interruption filtering (info message flushes the open turn as interrupted).
  events.push({
    kind: 'interruption',
    seq: seq++,
    label: 'interruption',
    barrier: true,
    messageId: 'int-trace-1',
    timestamp: nextTs(),
    content: 'Interrupted by user',
  })
  // 5e) Hidden insert then remove (must never affect grouping).
  const hiddenMsg: Message = { id: 'hidden-trace-1', role: 'info', content: 'hidden trace nudge', timestamp: nextTs(), hidden: true }
  events.push({ kind: 'hidden_insert', seq: seq++, label: 'hidden-insert', barrier: true, message: hiddenMsg })
  events.push({ kind: 'hidden_remove', seq: seq++, label: 'hidden-remove', barrier: true, messageId: 'hidden-trace-1' })

  // 5f) Full-session replacement (reconnect/replay). A server reconnect delivers
  //     a clean authoritative transcript: the base fixture plus the two trace
  //     turns finalized. Hidden/interruption artifacts are not part of it.
  const replacement: Message[] = [
    ...baseMessages.map((m) => ({ ...m })),
    { id: 'u-trace-1', role: 'user', content: 'Trace user boundary 1', timestamp: userTs1 },
    { id: authId, role: 'assistant', content: primaryContent, timestamp: startTs - C.TIME_STEP_MS },
    { id: 'u-trace-2', role: 'user', content: 'Trace user boundary 2', timestamp: userTs2 },
    { id: auth2Id, role: 'assistant', content: secondaryContent, timestamp: nextTs() },
  ]
  events.push({
    kind: 'full_session_replacement',
    seq: seq++,
    label: 'full-session-replacement',
    barrier: true,
    messages: replacement,
  })

  return events
}
