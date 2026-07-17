import { describe, it, expect } from 'bun:test'
import {
  generateCrftStreamV1,
  buildManifest,
  computeOracle,
  analyzeChurn,
} from '../index'
import * as C from '../constants'

describe('CRFT-STREAM-V1 fixture', () => {
  it('produces exactly 1,500 base messages with the specified distribution', () => {
    const { messages } = generateCrftStreamV1()
    expect(messages.length).toBe(C.TOTAL_MESSAGES)

    const manifest = buildManifest({ messages, trace: [] })
    expect(manifest.counts).toEqual({
      total: 1500,
      user: 100,
      finalAssistant: 100,
      tool: 900,
      intermediate: 300,
      special: 100,
    })
  })

  it('produces the exact tool payload size distribution (850 / 45 / 5)', () => {
    const { messages } = generateCrftStreamV1()
    const toolMsgs = messages.filter((m) => m.role === 'tool')
    expect(toolMsgs.length).toBe(900)
    let n2k = 0
    let n32k = 0
    let n192k = 0
    for (const m of toolMsgs) {
      const bytes = new TextEncoder().encode(m.toolResult ?? '').length
      if (bytes === C.TOOL_PAYLOAD_2KIB) n2k++
      else if (bytes === C.TOOL_PAYLOAD_32KIB) n32k++
      else if (bytes === C.TOOL_PAYLOAD_192KIB) n192k++
    }
    expect(n2k).toBe(850)
    expect(n32k).toBe(45)
    expect(n192k).toBe(5)
  })

  it('uses exactly six deterministic icon identities', () => {
    const { messages } = generateCrftStreamV1()
    const icons = new Set<string>()
    for (const m of messages) {
      if (m.toolDisplayMeta?.iconDataUrl) icons.add(m.toolDisplayMeta.iconDataUrl)
    }
    expect(icons.size).toBe(6)
  })

  it('is fully deterministic (identical manifest sha across regenerations)', () => {
    const a = buildManifest(generateCrftStreamV1())
    const b = buildManifest(generateCrftStreamV1())
    expect(a.fixtureSha256).toBe(b.fixtureSha256)
    expect(a.orderedMessages).toEqual(b.orderedMessages)
  })

  it('has a stable, non-empty replay oracle across regenerations', () => {
    const o1 = computeOracle(generateCrftStreamV1())
    const o2 = computeOracle(generateCrftStreamV1())
    expect(o1).toEqual(o2)
    expect(o1.barriers.length).toBeGreaterThan(0)
    expect(o1.finalGroupingHash).toMatch(/^[0-9a-f]{64}$/)
    expect(o1.finalTranscriptHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('advances the ordered-message hash as deltas mutate the streaming message', () => {
    const o = computeOracle(generateCrftStreamV1())
    // The four primary-delta barriers must have distinct ordered hashes because
    // the streaming message content grows by 32 bytes each delta.
    const primary = o.barriers.filter((b) => b.label.startsWith('primary-delta-'))
    expect(primary.length).toBeGreaterThanOrEqual(2)
    const hashes = new Set(primary.map((b) => b.orderedMessagesHash))
    expect(hashes.size).toBe(primary.length)
  })

  it('includes equal-timestamp ties and a parent/child tool pair', () => {
    const { messages } = generateCrftStreamV1()
    // Equal-timestamp tie in turn 89 tools.
    const t2 = messages.find((m) => m.id === 't89-2')!
    const t3 = messages.find((m) => m.id === 't89-3')!
    expect(t3.timestamp).toBe(t2.timestamp)
    // Parent/child tool pair.
    const parent = messages.find((m) => m.id === 't89-0')!
    const child = messages.find((m) => m.id === 't89-1')!
    expect(parent.toolName).toBe('Task')
    expect(child.parentToolUseId).toBe(parent.toolUseId)
  })
})

describe('CRFT-STREAM-V1 baseline churn analysis', () => {
  it('shows completed historical turns re-render on every ordinary delta', () => {
    // Bounded delta count for test speed; the artifact script runs the full stream.
    const r = analyzeChurn({ deltaLimit: 50 })
    expect(r.deltasApplied).toBe(50)
    expect(r.visibleCompletedTurns).toBeGreaterThan(0)
    // Every visible completed turn re-renders every delta → rate ~1.0.
    expect(r.historicalRerenderRate).toBeGreaterThan(0.99)
    expect(r.completedHistoricalTurnRenders).toBe(r.deltasApplied * r.visibleCompletedTurns)
  })
})
