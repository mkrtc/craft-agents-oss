/**
 * streamPerf.ts — CRFT-STREAM-V1 opt-in render instrumentation.
 *
 * Purpose
 * -------
 * Provides content-free render counters used by the R0 renderer performance
 * baseline (see the CRFT Final Orchestrator Plan, task R0). The counters let the
 * `ChatStreamingPerfHarness` playground component (Lane A) and, when enabled, the
 * packaged application (Lane B) measure renderer amplification during AI streaming
 * WITHOUT recording any prompt, tool, path, or credential content.
 *
 * Design constraints (from the plan):
 * - **Opt-in**: disabled by default. Baseline instrumentation must not alter
 *   normal production behavior unless explicitly enabled.
 * - **Content-free**: only integer tallies are ever stored. No message content,
 *   ids, tool names, paths, or credentials are captured here.
 * - **Zero-cost when disabled**: each hook is a single boolean read + early return.
 *
 * The state lives on `globalThis` under a namespaced key so that the counters are
 * shared across bundles/modules (ui package + electron renderer) that may be
 * evaluated as separate module instances.
 */

/** Content-free render counters. Every field is a non-negative integer tally. */
export interface StreamPerfCounters {
  /** Number of ChatDisplay function-body entries (render attempts). */
  chatDisplayRenders: number
  /** TurnCard function-body entries for completed, non-streaming turns. */
  completedTurnRenders: number
  /** TurnCard function-body entries for active (streaming/incomplete) turns. */
  activeTurnRenders: number
}

interface StreamPerfState {
  enabled: boolean
  counters: StreamPerfCounters
}

const GLOBAL_KEY = '__CRFT_STREAM_PERF__'

function freshCounters(): StreamPerfCounters {
  return { chatDisplayRenders: 0, completedTurnRenders: 0, activeTurnRenders: 0 }
}

function getState(): StreamPerfState {
  // globalThis is available in browser, electron renderer, node, and bun.
  const g = globalThis as unknown as Record<string, StreamPerfState | undefined>
  let state = g[GLOBAL_KEY]
  if (!state) {
    state = { enabled: false, counters: freshCounters() }
    g[GLOBAL_KEY] = state
  }
  return state
}

/**
 * Fast enabled check used by the render hooks. A single property read; when the
 * global has never been created this still returns false (getState lazily
 * initializes a disabled state).
 */
export function isStreamPerfEnabled(): boolean {
  const g = globalThis as unknown as Record<string, StreamPerfState | undefined>
  const state = g[GLOBAL_KEY]
  return state?.enabled === true
}

/** Enable counting. Resets counters unless `keepCounts` is true. */
export function enableStreamPerf(keepCounts = false): void {
  const state = getState()
  state.enabled = true
  if (!keepCounts) state.counters = freshCounters()
}

/** Disable counting. Existing counts are preserved for read-out. */
export function disableStreamPerf(): void {
  getState().enabled = false
}

/** Zero all counters without changing the enabled flag. */
export function resetStreamPerfCounters(): void {
  getState().counters = freshCounters()
}

/** Return a snapshot copy of the current counters. */
export function getStreamPerfCounters(): StreamPerfCounters {
  return { ...getState().counters }
}

/**
 * Record one ChatDisplay render (function-body entry). Call at the very top of
 * the ChatDisplay component body. No-op unless instrumentation is enabled.
 */
export function recordChatDisplayRender(): void {
  const g = globalThis as unknown as Record<string, StreamPerfState | undefined>
  const state = g[GLOBAL_KEY]
  if (state?.enabled !== true) return
  state.counters.chatDisplayRenders++
}

/**
 * Record one TurnCard render (function-body entry). Call at the very top of the
 * TurnCard component body. Splits into completed vs active tallies so the harness
 * can report `completedHistoricalTurnRenders` (completed cards re-rendering during
 * ordinary active-turn deltas) separately from `activeTurnRenders`.
 *
 * @param isComplete  props.isComplete for this TurnCard
 * @param isStreaming props.isStreaming for this TurnCard
 */
export function recordTurnCardRender(isComplete: boolean, isStreaming: boolean): void {
  const g = globalThis as unknown as Record<string, StreamPerfState | undefined>
  const state = g[GLOBAL_KEY]
  if (state?.enabled !== true) return
  if (isComplete && !isStreaming) {
    state.counters.completedTurnRenders++
  } else {
    state.counters.activeTurnRenders++
  }
}
