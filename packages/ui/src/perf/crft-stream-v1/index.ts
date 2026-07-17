/**
 * CRFT-STREAM-V1 — deterministic renderer benchmark fixture, trace, oracle and
 * manifest. Frozen by R0; consumed unchanged by R1/R2/T0.
 *
 * See the CRFT Final Orchestrator Plan §"Deterministic renderer benchmark source
 * of truth: CRFT-STREAM-V1".
 */
export * from './constants'
export * from './types'
export { generateCrftStreamV1 } from './generator'
export { applyTraceEvent } from './reducer'
export {
  computeOracle,
  hashOrderedMessages,
  hashGrouping,
  hashTranscript,
  validateReplay,
  type ReplayValidationResult,
} from './oracle'
export { buildManifest } from './manifest'
export { analyzeChurn, type ChurnAnalysisResult } from './churn-analysis'
