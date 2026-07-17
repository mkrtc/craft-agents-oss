/**
 * ChatStreamingPerfHarness.tsx — Lane A deterministic renderer performance
 * harness for CRFT-STREAM-V1 (see the CRFT Final Orchestrator Plan, task R0).
 *
 * It renders a faithful, minimal ChatDisplay-like surface (canonical
 * `groupMessagesByTurn` in a useMemo keyed on messages, reverse-paginated to the
 * last N turns, mapped to the real `TurnCard`) and replays the CRFT-STREAM-V1
 * trace against it while collecting CONTENT-FREE metrics:
 *   - completedHistoricalTurnRenders / activeTurnRenders / chatDisplayRenders
 *     (from perf/streamPerf counters)
 *   - browser long tasks > 100 ms (count, p95, max, aggregate)
 *   - event-dispatch → next-paint latency (p50, p95, max)
 *   - event-oracle hash pass/fail against the committed expectation
 *
 * URL parameters (all optional):
 *   ?component=chat-stream-perf   select this harness (PlaygroundApp)
 *   &trace=CRFT-STREAM-V1         trace id (only this trace is supported)
 *   &autorun=1                    start the protocol automatically on mount
 *   &runs=5                       repetitions (median + p95/max reported)
 *   &variant=primary             primary | activities-expanded | search | pagination
 *   &cadence=50                   ms between deltas (paced mode)
 *   &warmup=10000                 warmup idle ms before the measured trace
 *   &mode=paced                   paced | fast
 *   &deltaLimit=1200              cap on primary deltas (for quick runs)
 *
 * NOTHING here logs prompt/tool/path/credential content; only integer tallies
 * and timing numbers are produced.
 */
import * as React from 'react'
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { TurnCard, groupMessagesByTurn, getAssistantTurnUiKey } from '@craft-agent/ui'
import type { Turn, AssistantTurn } from '@craft-agent/ui'
import {
  enableStreamPerf,
  disableStreamPerf,
  resetStreamPerfCounters,
  getStreamPerfCounters,
  recordChatDisplayRender,
} from '@craft-agent/ui/perf/streamPerf'
import {
  generateCrftStreamV1,
  applyTraceEvent,
  computeOracle,
  validateReplay,
  GENERATOR_ID,
  GENERATOR_VERSION,
  PRIMARY_VARIANT,
  DELTA_CADENCE_MS,
  WARMUP_MS,
  BASELINE_RUNS,
} from '@craft-agent/ui/perf/crft-stream-v1'
import type { CrftStreamFixture, TraceEvent } from '@craft-agent/ui/perf/crft-stream-v1'
import type { Message } from '@craft-agent/core'

// ---------------------------------------------------------------------------
// URL params
// ---------------------------------------------------------------------------

type Variant = 'primary' | 'activities-expanded' | 'search' | 'pagination'

interface HarnessParams {
  trace: string
  autorun: boolean
  runs: number
  variant: Variant
  cadenceMs: number
  warmupMs: number
  mode: 'paced' | 'fast'
  deltaLimit: number | null
}

function readParams(): HarnessParams {
  const q = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams()
  const num = (k: string, d: number) => {
    const v = q.get(k)
    const n = v == null ? NaN : Number(v)
    return Number.isFinite(n) ? n : d
  }
  const variant = (q.get('variant') as Variant) || 'primary'
  return {
    trace: q.get('trace') || GENERATOR_ID,
    autorun: q.get('autorun') === '1',
    runs: Math.max(1, Math.floor(num('runs', BASELINE_RUNS))),
    variant: ['primary', 'activities-expanded', 'search', 'pagination'].includes(variant) ? variant : 'primary',
    cadenceMs: Math.max(0, num('cadence', DELTA_CADENCE_MS)),
    warmupMs: Math.max(0, num('warmup', WARMUP_MS)),
    mode: q.get('mode') === 'fast' ? 'fast' : 'paced',
    deltaLimit: q.get('deltaLimit') != null ? Math.max(1, Math.floor(num('deltaLimit', 1200))) : null,
  }
}

// ---------------------------------------------------------------------------
// Metric helpers
// ---------------------------------------------------------------------------

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1))
  return sortedAsc[idx]!
}
function median(values: number[]): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const macrotask = () => new Promise<void>((r) => setTimeout(r, 0))
/** Resolve just before the next paint (double rAF), returning performance.now(). */
function paintTime(): Promise<number> {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now()))))
}
/** True when the document is visible (rAF/timers run at full rate). */
function docVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible'
}
/**
 * Let React commit the pending setState and settle layout, returning the elapsed
 * time since `dispatch`. Uses double-rAF (event → next paint) when the document
 * is visible; when hidden (agent-controlled/offscreen browsers throttle rAF to
 * ~1 fps) it falls back to a macrotask + forced reflow so render counts and the
 * oracle still complete — latency then reflects commit→layout, not true paint,
 * and is flagged via `documentHiddenDuringRun` in the result.
 */
async function settleAndMeasure(dispatch: number): Promise<number> {
  if (docVisible()) {
    const painted = await paintTime()
    return painted - dispatch
  }
  await macrotask() // allow React's scheduler (MessageChannel) macrotask to commit
  if (typeof document !== 'undefined') void document.body.offsetHeight // force reflow
  return performance.now() - dispatch
}

interface RunResult {
  run: number
  variant: Variant
  counters: { completedHistoricalTurnRenders: number; activeTurnRenders: number; chatDisplayRenders: number }
  longTasks: { count: number; p95Ms: number; maxMs: number; aggregateMs: number }
  eventToPaintMs: { p50: number; p95: number; max: number; samples: number }
  oracle: { pass: boolean; finalGroupingHash: string; finalTranscriptHash: string; mismatches: string[] }
  deltasApplied: number
  wallClockMs: number
  /** True if the document was hidden at any point (rAF throttled → latency is commit→layout, not true paint; render counts remain valid). */
  documentHiddenDuringRun: boolean
}

interface AggregateResult {
  generatorId: string
  generatorVersion: string
  trace: string
  variant: Variant
  runs: number
  mode: 'paced' | 'fast'
  cadenceMs: number
  warmupMs: number
  environment: Record<string, unknown>
  runResults: RunResult[]
  summary: {
    completedHistoricalTurnRenders: { median: number; p95: number; max: number }
    activeTurnRenders: { median: number; p95: number; max: number }
    chatDisplayRenders: { median: number; p95: number; max: number }
    longTaskP95Ms: { median: number; max: number }
    longTaskMaxMs: { median: number; max: number }
    eventToPaintP95Ms: { median: number; max: number }
    eventToPaintMaxMs: { median: number; max: number }
    oraclePass: boolean
    documentHiddenDuringAnyRun: boolean
  }
}

function collectEnvironment(): Record<string, unknown> {
  const nav = typeof navigator !== 'undefined' ? navigator : ({} as Navigator)
  return {
    userAgent: (nav as Navigator).userAgent ?? 'unknown',
    hardwareConcurrency: (nav as Navigator).hardwareConcurrency ?? null,
    deviceMemory: (nav as unknown as { deviceMemory?: number }).deviceMemory ?? null,
    viewport: typeof window !== 'undefined' ? { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio } : null,
    reactStrictModeNote: 'Production timing must use the production build; StrictMode double-renders are dev-only.',
  }
}

// ---------------------------------------------------------------------------
// Faithful ChatDisplay-like surface
// ---------------------------------------------------------------------------

const STABLE_EMPTY_SET = new Set<string>()

interface SurfaceProps {
  messages: Message[]
  isProcessing: boolean
  visibleTurns: number
  activitiesExpanded: boolean
  compactResponseWindow: boolean
}

/**
 * Mirrors the production ChatDisplay render path for the perf-relevant subset:
 * canonical grouping in a useMemo keyed on messages, reverse pagination to the
 * last N turns, and the real `TurnCard` for assistant turns with stable
 * callbacks/sets (so only content refs — activities/response — churn per delta).
 */
const ChatStreamingPerfSurface = React.memo(function ChatStreamingPerfSurface({
  messages,
  isProcessing,
  visibleTurns,
  activitiesExpanded,
  compactResponseWindow,
}: SurfaceProps) {
  // Represents the ChatDisplay container render.
  recordChatDisplayRender()

  const allTurns = useMemo(
    () => groupMessagesByTurn(messages, { isSessionProcessing: isProcessing }),
    [messages, isProcessing],
  )
  const startIndex = Math.max(0, allTurns.length - visibleTurns)
  const turns = allTurns.slice(startIndex)

  const noop = useCallback(() => {}, [])

  return (
    <div className="flex flex-col gap-2 px-5 py-6">
      {turns.map((turn: Turn, index: number) => {
        if (turn.type === 'user') {
          return (
            <div key={`u:${turn.message.id}`} className="self-end max-w-[80%] rounded-2xl bg-foreground text-background px-4 py-2 text-sm">
              {turn.message.content.slice(0, 80)}
            </div>
          )
        }
        if (turn.type === 'system' || turn.type === 'auth-request') {
          return (
            <div key={`s:${turn.message.id}`} className="text-xs text-muted-foreground px-2 py-1">
              [{turn.message.role}] {turn.message.id}
            </div>
          )
        }
        const at = turn as AssistantTurn
        const isLastResponse = index === turns.length - 1 || !turns.slice(index + 1).some((t) => t.type === 'user')
        return (
          <TurnCard
            key={getAssistantTurnUiKey(at, index)}
            sessionId="crft-stream-v1"
            turnId={at.turnId}
            activities={at.activities}
            response={at.response}
            intent={at.intent}
            isStreaming={at.isStreaming}
            isComplete={at.isComplete}
            isExpanded={activitiesExpanded}
            onExpandedChange={noop}
            expandedActivityGroups={STABLE_EMPTY_SET}
            collapsedActivityGroups={STABLE_EMPTY_SET}
            compactResponseWindow={compactResponseWindow}
            todos={at.todos}
            isLastResponse={isLastResponse}
            displayMode="detailed"
          />
        )
      })}
    </div>
  )
})

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export function ChatStreamingPerfHarness() {
  const params = useMemo(readParams, [])
  const fixture = useMemo<CrftStreamFixture>(() => generateCrftStreamV1(), [])
  const expectedOracle = useMemo(() => computeOracle(fixture), [fixture])

  const [messages, setMessages] = useState<Message[]>(() => fixture.messages)
  const [isProcessing, setIsProcessing] = useState(false)
  const [status, setStatus] = useState<string>('idle')
  const [result, setResult] = useState<AggregateResult | null>(null)
  const runningRef = useRef(false)

  const variantConfig = useMemo(() => {
    switch (params.variant) {
      case 'activities-expanded':
        return { visibleTurns: PRIMARY_VARIANT.visibleTurns, activitiesExpanded: true }
      case 'pagination':
        return { visibleTurns: 40, activitiesExpanded: false }
      case 'search':
      case 'primary':
      default:
        return { visibleTurns: PRIMARY_VARIANT.visibleTurns, activitiesExpanded: false }
    }
  }, [params.variant])

  const primaryDeltaTotal = useMemo(
    () => fixture.trace.filter((e) => e.kind === 'text_delta' && e.messageId === 'tmp-active-1').length,
    [fixture],
  )

  const runProtocol = useCallback(async () => {
    if (runningRef.current) return
    runningRef.current = true
    setResult(null)

    const runResults: RunResult[] = []

    for (let run = 1; run <= params.runs; run++) {
      // Reset surface to the base fixture and settle.
      setStatus(`run ${run}/${params.runs}: reset`)
      setMessages(fixture.messages)
      setIsProcessing(false)
      await macrotask()
      await macrotask()

      // Warmup (idle).
      setStatus(`run ${run}/${params.runs}: warmup ${params.warmupMs}ms`)
      await delay(params.warmupMs)

      // Long task observer for the measured window.
      const longTasks: number[] = []
      let observer: PerformanceObserver | null = null
      try {
        observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.duration > 100) longTasks.push(entry.duration)
          }
        })
        observer.observe({ entryTypes: ['longtask'] })
      } catch {
        observer = null // longtask unsupported
      }

      // Begin measurement.
      resetStreamPerfCounters()
      enableStreamPerf(true)
      setIsProcessing(true)
      const latencies: number[] = []
      const wallStart = performance.now()

      // Build the ordered event list, honoring an optional primary delta cap.
      const events = params.deltaLimit == null
        ? fixture.trace
        : capPrimaryDeltas(fixture.trace, params.deltaLimit)

      setStatus(`run ${run}/${params.runs}: replay (${events.length} events)`)
      let live = fixture.messages
      let applied = 0
      let hiddenObserved = false
      for (const event of events) {
        const dispatch = performance.now()
        live = applyTraceEvent(live, event)
        setMessages(live)
        if (!docVisible()) hiddenObserved = true
        // Settle the render (double-rAF when visible, macrotask+reflow when
        // hidden) and record event → settle latency for a sampled subset.
        const lat = await settleAndMeasure(dispatch)
        if (params.mode === 'paced' || applied % 4 === 0) latencies.push(lat)
        applied++
        // Pace deltas only when visible; when hidden timers are throttled so we
        // run as fast as possible to complete the run (render counts stay valid).
        if (event.kind === 'text_delta' && params.mode === 'paced' && params.cadenceMs > 0 && docVisible()) {
          const spent = performance.now() - dispatch
          if (spent < params.cadenceMs) await delay(params.cadenceMs - spent)
        }
      }
      // Flush any trailing renders before reading counters.
      await macrotask()
      await macrotask()
      const wallEnd = performance.now()
      setIsProcessing(false)
      disableStreamPerf()
      observer?.disconnect()

      const counters = getStreamPerfCounters()

      // Oracle check: validate the ACTUAL replayed `live` state (built by this
      // loop's own incremental applyTraceEvent + setMessages calls) against an
      // independent pure-fold replay of the same `events`, plus the frozen R0
      // baseline when the full uncapped trace ran. See validateReplay's doc for
      // why a fresh `computeOracle(fixture)` recompute cannot catch replay bugs.
      const replay = validateReplay(fixture, events, live, expectedOracle)
      const { pass: oraclePass, mismatches, groupingHash: finalGroupingHash, transcriptHash: finalTranscriptHash } = replay

      const sortedLat = [...latencies].sort((a, b) => a - b)
      const sortedLong = [...longTasks].sort((a, b) => a - b)
      runResults.push({
        run,
        variant: params.variant,
        counters: {
          completedHistoricalTurnRenders: counters.completedTurnRenders,
          activeTurnRenders: counters.activeTurnRenders,
          chatDisplayRenders: counters.chatDisplayRenders,
        },
        longTasks: {
          count: longTasks.length,
          p95Ms: percentile(sortedLong, 95),
          maxMs: sortedLong.length ? sortedLong[sortedLong.length - 1]! : 0,
          aggregateMs: longTasks.reduce((a, b) => a + b, 0),
        },
        eventToPaintMs: {
          p50: percentile(sortedLat, 50),
          p95: percentile(sortedLat, 95),
          max: sortedLat.length ? sortedLat[sortedLat.length - 1]! : 0,
          samples: sortedLat.length,
        },
        oracle: { pass: oraclePass, finalGroupingHash, finalTranscriptHash, mismatches },
        deltasApplied: applied,
        wallClockMs: wallEnd - wallStart,
        documentHiddenDuringRun: hiddenObserved,
      })

      setStatus(`run ${run}/${params.runs}: done`)
      await delay(200)
    }

    // Aggregate.
    const pick = (fn: (r: RunResult) => number) => runResults.map(fn)
    const aggregate: AggregateResult = {
      generatorId: GENERATOR_ID,
      generatorVersion: GENERATOR_VERSION,
      trace: params.trace,
      variant: params.variant,
      runs: params.runs,
      mode: params.mode,
      cadenceMs: params.cadenceMs,
      warmupMs: params.warmupMs,
      environment: collectEnvironment(),
      runResults,
      summary: {
        completedHistoricalTurnRenders: agg(pick((r) => r.counters.completedHistoricalTurnRenders)),
        activeTurnRenders: agg(pick((r) => r.counters.activeTurnRenders)),
        chatDisplayRenders: agg(pick((r) => r.counters.chatDisplayRenders)),
        longTaskP95Ms: { median: median(pick((r) => r.longTasks.p95Ms)), max: Math.max(...pick((r) => r.longTasks.p95Ms), 0) },
        longTaskMaxMs: { median: median(pick((r) => r.longTasks.maxMs)), max: Math.max(...pick((r) => r.longTasks.maxMs), 0) },
        eventToPaintP95Ms: { median: median(pick((r) => r.eventToPaintMs.p95)), max: Math.max(...pick((r) => r.eventToPaintMs.p95), 0) },
        eventToPaintMaxMs: { median: median(pick((r) => r.eventToPaintMs.max)), max: Math.max(...pick((r) => r.eventToPaintMs.max), 0) },
        oraclePass: runResults.every((r) => r.oracle.pass),
        documentHiddenDuringAnyRun: runResults.some((r) => r.documentHiddenDuringRun),
      },
    }

    setResult(aggregate)
    ;(window as unknown as Record<string, unknown>).__CRFT_STREAM_V1_RESULT__ = aggregate
    setStatus('complete')
    runningRef.current = false

    // Auto-download for evidence capture.
    try {
      const blob = new Blob([JSON.stringify(aggregate, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `crft-stream-v1-r0-lane-a-${params.variant}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      // Download unavailable (e.g. headless); result is on window instead.
    }
  }, [params, fixture, expectedOracle, primaryDeltaTotal])

  useEffect(() => {
    if (params.autorun) void runProtocol()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="w-full h-full flex flex-col bg-background text-foreground">
      <div className="shrink-0 border-b border-border p-3 flex items-center gap-3 text-xs">
        <strong>CRFT-STREAM-V1 Perf Harness</strong>
        <span className="text-muted-foreground">variant={params.variant} · runs={params.runs} · mode={params.mode} · cadence={params.cadenceMs}ms · warmup={params.warmupMs}ms</span>
        <button
          className="ml-auto px-3 py-1 rounded bg-foreground text-background disabled:opacity-50"
          onClick={() => void runProtocol()}
          disabled={status !== 'idle' && status !== 'complete'}
        >
          Run baseline
        </button>
        <span data-testid="harness-status">status: {status}</span>
      </div>

      {result && (
        <div className="shrink-0 border-b border-border p-3 text-xs font-mono space-y-1">
          <div>completedHistoricalTurnRenders: median={result.summary.completedHistoricalTurnRenders.median} p95={result.summary.completedHistoricalTurnRenders.p95} max={result.summary.completedHistoricalTurnRenders.max}</div>
          <div>activeTurnRenders: median={result.summary.activeTurnRenders.median}</div>
          <div>chatDisplayRenders: median={result.summary.chatDisplayRenders.median}</div>
          <div>longTask p95(ms): median={result.summary.longTaskP95Ms.median.toFixed(1)} max={result.summary.longTaskMaxMs.max.toFixed(1)}</div>
          <div>eventToPaint p95(ms): median={result.summary.eventToPaintP95Ms.median.toFixed(1)} max={result.summary.eventToPaintMaxMs.max.toFixed(1)}</div>
          <div>oracle: {result.summary.oraclePass ? 'PASS' : 'FAIL'}</div>
          <div className="text-muted-foreground">window.__CRFT_STREAM_V1_RESULT__ set; JSON auto-downloaded.</div>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        <ChatStreamingPerfSurface
          messages={messages}
          isProcessing={isProcessing}
          visibleTurns={variantConfig.visibleTurns}
          activitiesExpanded={variantConfig.activitiesExpanded}
          compactResponseWindow={PRIMARY_VARIANT.compactResponseWindow}
        />
      </div>
    </div>
  )
}

// Aggregate median/p95/max of a numeric array.
function agg(values: number[]): { median: number; p95: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b)
  return { median: median(values), p95: percentile(sorted, 95), max: sorted.length ? sorted[sorted.length - 1]! : 0 }
}

/** Keep the first `limit` primary (tmp-active-1) text_delta events; drop the rest. */
function capPrimaryDeltas(trace: TraceEvent[], limit: number): TraceEvent[] {
  let seen = 0
  const out: TraceEvent[] = []
  for (const e of trace) {
    if (e.kind === 'text_delta' && e.messageId === 'tmp-active-1') {
      if (seen >= limit) continue
      seen++
    }
    out.push(e)
  }
  return out
}
