/**
 * manifest.ts — build the canonical, deterministic CRFT-STREAM-V1 fixture
 * manifest (committed artifact). It records the generator identity, seed, exact
 * counts, byte totals, the ordered id/role/timestamp list, and a SHA-256 over
 * the base fixture.
 */
import type { Message } from '@craft-agent/core'
import { hashTranscript } from './oracle'
import * as C from './constants'
import type { CrftStreamFixture, CrftStreamManifest, ManifestMessageRef } from './types'

function byteLen(s: string | undefined): number {
  if (!s) return 0
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length
  // Fallback: count UTF-8 bytes manually.
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++ }
    else n += 3
  }
  return n
}

export function buildManifest(fixture: CrftStreamFixture): CrftStreamManifest {
  const messages = fixture.messages

  let user = 0
  let finalAssistant = 0
  let tool = 0
  let intermediate = 0
  let toolResultBytes = 0
  let contentBytes = 0

  const orderedMessages: ManifestMessageRef[] = []
  for (const m of messages) {
    orderedMessages.push({ id: m.id, role: m.role, timestamp: m.timestamp })
    contentBytes += byteLen(m.content)
    if (m.toolResult) toolResultBytes += byteLen(m.toolResult)
    if (m.role === 'user') user++
    else if (m.role === 'tool') tool++
    else if (m.role === 'assistant') {
      if (m.isIntermediate) intermediate++
      else finalAssistant++
    }
  }
  const special = messages.length - user - tool - intermediate - finalAssistant

  return {
    generatorId: C.GENERATOR_ID,
    generatorVersion: C.GENERATOR_VERSION,
    harnessSlug: C.HARNESS_SLUG,
    seed: C.SEED,
    seedHex: `0x${C.SEED.toString(16)}`,
    timeOriginMs: C.TIME_ORIGIN_MS,
    counts: { total: messages.length, user, finalAssistant, tool, intermediate, special },
    toolPayloadDistribution: {
      bytes2KiB: C.TOOL_PAYLOAD_2KIB_COUNT,
      bytes32KiB: C.TOOL_PAYLOAD_32KIB_COUNT,
      bytes192KiB: C.TOOL_PAYLOAD_192KIB_COUNT,
    },
    byteTotals: { toolResultBytes, contentBytes },
    traceEventCount: fixture.trace.length,
    orderedMessages,
    fixtureSha256: hashTranscript(messages as Message[]),
  }
}
