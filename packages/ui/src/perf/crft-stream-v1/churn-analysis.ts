/**
 * churn-analysis.ts — deterministic, content-free proof that completed historical
 * turns re-render during ordinary streaming deltas (the confirmed renderer
 * amplification, per the CRFT plan).
 *
 * It replays the primary text_delta stream through the SAME reducer and the SAME
 * canonical `groupMessagesByTurn` the app uses, then for each delta evaluates —
 * for every completed, non-streaming turn in the visible window — the decision
 * the production `TurnCard` memo comparator makes:
 *
 *   A completed, non-streaming TurnCard re-renders when its `activities` or
 *   `response` prop reference changes (all other completed-branch checks —
 *   isLastResponse, expansion, displayMode, compactMode, annotationInteraction —
 *   are held stable here, matching the primary UI variant).
 *
 * Because `groupMessagesByTurn` builds fresh turn/activity/response objects on
 * every call, those references change every delta, so every visible completed
 * turn re-renders on every delta. This module quantifies that.
 *
 * This intentionally does NOT import `TurnCard.tsx` (which pulls React/DOM-only
 * deps) so it runs in a plain node/bun script. The decision above mirrors the
 * completed-turn branch of the TurnCard comparator verbatim.
 */
import { groupMessagesByTurn } from '../../components/chat/turn-utils'
import type { AssistantTurn, Turn } from '../../components/chat/turn-utils'
import { generateCrftStreamV1 } from './generator'
import { applyTraceEvent } from './reducer'
import * as C from './constants'

export interface ChurnAnalysisResult {
  generatorId: string
  generatorVersion: string
  visibleTurns: number
  deltasApplied: number
  /** Completed assistant turns present in the visible window (stable across deltas). */
  visibleCompletedTurns: number
  /** Total completed-historical TurnCard re-renders across all deltas. */
  completedHistoricalTurnRenders: number
  /** Average completed-historical re-renders per delta. */
  completedHistoricalRendersPerDelta: number
  /** Active turn re-renders (the streaming turn re-renders every delta). */
  activeTurnRenders: number
  /** ChatDisplay re-renders (the container re-renders every delta). */
  chatDisplayRenders: number
  /** Fraction of visible completed turns that re-render per delta (expected ~1.0). */
  historicalRerenderRate: number
}

function isCompletedAssistant(t: Turn | undefined): t is AssistantTurn {
  return !!t && t.type === 'assistant' && (t as AssistantTurn).isComplete && !(t as AssistantTurn).isStreaming
}

/**
 * Replay the primary delta stream and count completed-historical re-renders.
 *
 * @param deltaLimit optional cap on deltas (defaults to the full primary stream)
 */
export function analyzeChurn(options: { visibleTurns?: number; deltaLimit?: number } = {}): ChurnAnalysisResult {
  const visibleTurns = options.visibleTurns ?? C.PRIMARY_VARIANT.visibleTurns
  const fixture = generateCrftStreamV1()

  let messages = fixture.messages

  // Advance to the first delta: apply the primary stream_start (creates the
  // active streaming turn). Collect the ordered primary text_delta events.
  const primaryDeltas = fixture.trace.filter(
    (e) => e.kind === 'text_delta' && e.messageId === 'tmp-active-1',
  )
  const streamStart = fixture.trace.find((e) => e.kind === 'stream_start' && e.messageId === 'tmp-active-1')
  if (streamStart) messages = applyTraceEvent(messages, streamStart)

  const deltaCount = Math.min(options.deltaLimit ?? primaryDeltas.length, primaryDeltas.length)

  const visibleSlice = (turns: Turn[]) => turns.slice(Math.max(0, turns.length - visibleTurns))

  let prev = visibleSlice(groupMessagesByTurn(messages, { isSessionProcessing: true }))
  let completedHistoricalTurnRenders = 0
  let visibleCompletedTurns = 0

  for (let d = 0; d < deltaCount; d++) {
    messages = applyTraceEvent(messages, primaryDeltas[d]!)
    const next = visibleSlice(groupMessagesByTurn(messages, { isSessionProcessing: true }))

    // Match visible turns by position (stable during ordinary active-turn deltas).
    const n = Math.min(prev.length, next.length)
    let completedThisDelta = 0
    for (let i = 0; i < n; i++) {
      const pt = prev[i]
      const nt = next[i]
      if (isCompletedAssistant(pt) && isCompletedAssistant(nt)) {
        completedThisDelta++
        // Completed-turn comparator decision: re-render iff activities/response
        // reference changed. groupMessagesByTurn always creates fresh refs, so
        // this is true every delta.
        if (pt.activities !== nt.activities || pt.response !== nt.response) {
          completedHistoricalTurnRenders++
        }
      }
    }
    visibleCompletedTurns = completedThisDelta
    prev = next
  }

  const perDelta = deltaCount > 0 ? completedHistoricalTurnRenders / deltaCount : 0
  return {
    generatorId: C.GENERATOR_ID,
    generatorVersion: C.GENERATOR_VERSION,
    visibleTurns,
    deltasApplied: deltaCount,
    visibleCompletedTurns,
    completedHistoricalTurnRenders,
    completedHistoricalRendersPerDelta: perDelta,
    activeTurnRenders: deltaCount,
    chatDisplayRenders: deltaCount,
    historicalRerenderRate: visibleCompletedTurns > 0 ? perDelta / visibleCompletedTurns : 0,
  }
}
