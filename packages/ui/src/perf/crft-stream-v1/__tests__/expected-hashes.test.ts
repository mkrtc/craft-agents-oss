import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateCrftStreamV1 } from '../generator'
import { buildManifest } from '../manifest'
import { computeOracle } from '../oracle'

/**
 * Pins the frozen CRFT-STREAM-V1 contract. `expected-hashes.json` is the
 * committed expectation (regenerate via scripts/generate-artifacts.ts). If the
 * generator/oracle output drifts, this test fails — which is exactly the point:
 * R1/R2/T0 must consume the identical fixture and hashes.
 */
describe('CRFT-STREAM-V1 frozen expectation contract', () => {
  const expected = JSON.parse(
    readFileSync(join(import.meta.dir, '..', 'expected', 'expected-hashes.json'), 'utf8'),
  )

  const fixture = generateCrftStreamV1()
  const manifest = buildManifest(fixture)
  const oracle = computeOracle(fixture)

  it('reproduces the committed counts and byte totals', () => {
    expect(manifest.counts).toEqual(expected.counts)
    expect(manifest.toolPayloadDistribution).toEqual(expected.toolPayloadDistribution)
    expect(manifest.byteTotals).toEqual(expected.byteTotals)
    expect(manifest.traceEventCount).toBe(expected.traceEventCount)
  })

  it('reproduces the committed fixture SHA-256', () => {
    expect(manifest.fixtureSha256).toBe(expected.fixtureSha256)
  })

  it('reproduces the committed oracle hashes', () => {
    expect(oracle.baseGroupingHash).toBe(expected.oracle.baseGroupingHash)
    expect(oracle.baseOrderedMessagesHash).toBe(expected.oracle.baseOrderedMessagesHash)
    expect(oracle.finalGroupingHash).toBe(expected.oracle.finalGroupingHash)
    expect(oracle.finalOrderedMessagesHash).toBe(expected.oracle.finalOrderedMessagesHash)
    expect(oracle.finalTranscriptHash).toBe(expected.oracle.finalTranscriptHash)
    expect(oracle.barriers).toEqual(expected.oracle.barriers)
  })
})
