/**
 * generate-artifacts.ts — emit the CRFT-STREAM-V1 R0 evidence artifacts.
 *
 * Writes:
 *   1. The compact, committed expectation contract
 *      (packages/ui/src/perf/crft-stream-v1/expected/expected-hashes.json).
 *      This is the "deterministic manifest and expected SHA-256/oracle" frozen
 *      in-repo; `expected-hashes.test.ts` asserts the generator reproduces it.
 *   2. The full evidence artifacts to a caller-supplied data folder (e.g. the
 *      current orchestrator/session's data directory), prefixed
 *      `crft-stream-v1-r0-`. These are large/generated and NOT committed.
 *
 * Usage:
 *   bun run packages/ui/src/perf/crft-stream-v1/scripts/generate-artifacts.ts <dataDir>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateCrftStreamV1 } from '../generator'
import { buildManifest } from '../manifest'
import { computeOracle } from '../oracle'
import { analyzeChurn } from '../churn-analysis'

const HERE = dirname(fileURLToPath(import.meta.url))
const EXPECTED_DIR = join(HERE, '..', 'expected')

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}

function main(): void {
  const dataDir = process.argv[2]
  if (!dataDir) {
    console.error('[crft-stream-v1] usage: generate-artifacts.ts <dataDir>')
    console.error('[crft-stream-v1] pass the current session/orchestrator data folder — there is no default.')
    process.exit(1)
  }

  const fixture = generateCrftStreamV1()
  const manifest = buildManifest(fixture)
  const oracle = computeOracle(fixture)
  const churn = analyzeChurn() // full primary delta stream

  // --- Committed compact expectation contract ---------------------------
  const expected = {
    generatorId: manifest.generatorId,
    generatorVersion: manifest.generatorVersion,
    seed: manifest.seed,
    seedHex: manifest.seedHex,
    harnessSlug: manifest.harnessSlug,
    counts: manifest.counts,
    toolPayloadDistribution: manifest.toolPayloadDistribution,
    byteTotals: manifest.byteTotals,
    traceEventCount: manifest.traceEventCount,
    fixtureSha256: manifest.fixtureSha256,
    oracle: {
      baseGroupingHash: oracle.baseGroupingHash,
      baseOrderedMessagesHash: oracle.baseOrderedMessagesHash,
      barriers: oracle.barriers,
      finalGroupingHash: oracle.finalGroupingHash,
      finalOrderedMessagesHash: oracle.finalOrderedMessagesHash,
      finalTranscriptHash: oracle.finalTranscriptHash,
    },
  }
  const expectedPath = join(EXPECTED_DIR, 'expected-hashes.json')
  writeJson(expectedPath, expected)
  console.log(`[crft-stream-v1] wrote committed expectation → ${expectedPath}`)

  // --- Full evidence artifacts (orchestrator data folder) ---------------
  const manifestPath = join(dataDir, 'crft-stream-v1-r0-manifest.json')
  const oraclePath = join(dataDir, 'crft-stream-v1-r0-oracle.json')
  const churnPath = join(dataDir, 'crft-stream-v1-r0-churn-analysis.json')
  writeJson(manifestPath, manifest)
  writeJson(oraclePath, oracle)
  writeJson(churnPath, { generatedFrom: 'analyzeChurn (node-light, real groupMessagesByTurn + reducer)', ...churn })
  console.log(`[crft-stream-v1] wrote manifest  → ${manifestPath}`)
  console.log(`[crft-stream-v1] wrote oracle    → ${oraclePath}`)
  console.log(`[crft-stream-v1] wrote churn     → ${churnPath}`)

  // --- Console summary --------------------------------------------------
  console.log('\n=== CRFT-STREAM-V1 R0 summary ===')
  console.log('counts:', JSON.stringify(manifest.counts))
  console.log('toolPayloadDistribution:', JSON.stringify(manifest.toolPayloadDistribution))
  console.log('byteTotals:', JSON.stringify(manifest.byteTotals))
  console.log('fixtureSha256:', manifest.fixtureSha256)
  console.log('oracle.finalGroupingHash:', oracle.finalGroupingHash)
  console.log('oracle.finalTranscriptHash:', oracle.finalTranscriptHash)
  console.log('oracle.barriers:', oracle.barriers.length)
  console.log('churn.deltasApplied:', churn.deltasApplied)
  console.log('churn.visibleCompletedTurns:', churn.visibleCompletedTurns)
  console.log('churn.completedHistoricalTurnRenders:', churn.completedHistoricalTurnRenders)
  console.log('churn.completedHistoricalRendersPerDelta:', churn.completedHistoricalRendersPerDelta.toFixed(2))
  console.log('churn.historicalRerenderRate:', churn.historicalRerenderRate.toFixed(4))
}

main()
