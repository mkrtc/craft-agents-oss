/**
 * types.ts — CRFT-STREAM-V1 fixture, trace, manifest and oracle type contracts.
 */
import type { Message } from '@craft-agent/core'

/**
 * A single trace event. Each mutation mirrors exactly one renderer-side state
 * transition. The reducer (`applyTraceEvent`) applies these the same way the
 * production renderer does (shallow-copy the messages array, replace/insert the
 * target message), so the oracle and the live harness share identical state.
 *
 * `seq` is a monotonically increasing trace sequence number used only by the
 * harness/oracle (never persisted into a Message). `barrier: true` marks a
 * semantic checkpoint at which the oracle records hashes.
 */
export type TraceEvent =
  | { kind: 'stream_start'; seq: number; label?: string; barrier?: boolean; userMessageId?: string; userTimestamp?: number; userContent?: string; messageId: string; timestamp: number; turnId: string }
  | { kind: 'text_delta'; seq: number; label?: string; barrier?: boolean; messageId: string; chunk: string }
  | { kind: 'text_complete'; seq: number; label?: string; barrier?: boolean; tempMessageId: string; messageId: string; timestamp: number; content: string; isIntermediate: boolean }
  | { kind: 'user_boundary'; seq: number; label?: string; barrier?: boolean; messageId: string; timestamp: number; content: string }
  | { kind: 'tool_late_complete'; seq: number; label?: string; barrier?: boolean; messageId: string; toolResult: string }
  | { kind: 'annotation_update'; seq: number; label?: string; barrier?: boolean; messageId: string; annotations: Message['annotations'] }
  | { kind: 'compaction_complete'; seq: number; label?: string; barrier?: boolean; messageId: string; timestamp: number; content: string }
  | { kind: 'hidden_insert'; seq: number; label?: string; barrier?: boolean; message: Message }
  | { kind: 'hidden_remove'; seq: number; label?: string; barrier?: boolean; messageId: string }
  | { kind: 'interruption'; seq: number; label?: string; barrier?: boolean; messageId: string; timestamp: number; content: string }
  | { kind: 'full_session_replacement'; seq: number; label?: string; barrier?: boolean; messages: Message[] }

/** The generated fixture: base messages + the replay trace. */
export interface CrftStreamFixture {
  messages: Message[]
  trace: TraceEvent[]
}

/** One ordered-message descriptor (content-free except role — no message body). */
export interface ManifestMessageRef {
  id: string
  role: string
  timestamp: number
}

/** Canonical, deterministic fixture manifest (committed artifact). */
export interface CrftStreamManifest {
  generatorId: string
  generatorVersion: string
  harnessSlug: string
  seed: number
  seedHex: string
  timeOriginMs: number
  counts: {
    total: number
    user: number
    finalAssistant: number
    tool: number
    intermediate: number
    special: number
  }
  toolPayloadDistribution: {
    bytes2KiB: number
    bytes32KiB: number
    bytes192KiB: number
  }
  byteTotals: {
    toolResultBytes: number
    contentBytes: number
  }
  traceEventCount: number
  /** Ordered list of message id/role/timestamp for the base fixture. */
  orderedMessages: ManifestMessageRef[]
  /** SHA-256 over the canonical serialization of the base fixture. */
  fixtureSha256: string
}

/** A hash checkpoint recorded at a trace barrier. */
export interface OracleBarrier {
  seq: number
  label: string
  /** SHA-256 of the ordered (stable-sorted, visible) message stream. */
  orderedMessagesHash: string
  /** SHA-256 of the canonical `groupMessagesByTurn` output. */
  groupingHash: string
}

/** Expected replay oracle (committed artifact). T0 replays and compares. */
export interface CrftStreamOracle {
  generatorId: string
  generatorVersion: string
  seed: number
  /** Hash of the base fixture before any trace event is applied. */
  baseGroupingHash: string
  baseOrderedMessagesHash: string
  barriers: OracleBarrier[]
  finalOrderedMessagesHash: string
  finalGroupingHash: string
  /** SHA-256 over the full final transcript (all messages, ordered by insertion). */
  finalTranscriptHash: string
}
