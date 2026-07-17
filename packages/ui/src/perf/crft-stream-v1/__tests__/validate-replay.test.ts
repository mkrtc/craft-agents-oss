import { describe, it, expect } from 'bun:test'
import {
  generateCrftStreamV1,
  computeOracle,
  applyTraceEvent,
  validateReplay,
} from '../index'

describe('validateReplay (Lane A harness replay oracle)', () => {
  it('passes when liveMessages is a correct full-trace replay', () => {
    const fixture = generateCrftStreamV1()
    const expectedOracle = computeOracle(fixture)
    const live = fixture.trace.reduce((acc, e) => applyTraceEvent(acc, e), fixture.messages)

    const result = validateReplay(fixture, fixture.trace, live, expectedOracle)
    expect(result.pass).toBe(true)
    expect(result.mismatches).toEqual([])
  })

  it('passes when liveMessages is a correct partial (deltaLimit-capped) replay', () => {
    const fixture = generateCrftStreamV1()
    const expectedOracle = computeOracle(fixture)
    const events = fixture.trace.slice(0, Math.floor(fixture.trace.length / 2))
    const live = events.reduce((acc, e) => applyTraceEvent(acc, e), fixture.messages)

    const result = validateReplay(fixture, events, live, expectedOracle)
    expect(result.pass).toBe(true)
    // A partial run cannot (and must not be expected to) match the frozen
    // full-trace baseline hash.
    expect(result.groupingHash).not.toBe(expectedOracle.finalGroupingHash)
  })

  // Regression test: a harness loop that silently stops applying events partway
  // through (e.g. a stale closure, a skipped setState, an early `break`) must be
  // caught even when the harness still claims to have run the full trace.
  it('fails when liveMessages diverges from the full-trace replay (regression: caught bug the old check missed)', () => {
    const fixture = generateCrftStreamV1()
    const expectedOracle = computeOracle(fixture)

    // Simulate the bug: the harness loop only actually applied the first half
    // of `fixture.trace` to `live` (e.g. it stopped early), but still reports
    // `events = fixture.trace` (the full, uncapped trace) to the oracle check —
    // exactly the shape of a real "harness silently under-replayed" regression.
    const halfway = Math.floor(fixture.trace.length / 2)
    const divergedLive = fixture.trace
      .slice(0, halfway)
      .reduce((acc, e) => applyTraceEvent(acc, e), fixture.messages)

    const result = validateReplay(fixture, fixture.trace, divergedLive, expectedOracle)
    expect(result.pass).toBe(false)
    expect(result.mismatches.length).toBeGreaterThan(0)

    // Demonstrates why the OLD implementation (recompute computeOracle(fixture)
    // fresh and compare it to `expectedOracle`) could never have caught this:
    // neither side of that comparison depends on `divergedLive` at all, so it
    // always reports a match regardless of what the harness actually replayed.
    const freshOracle = computeOracle(fixture)
    expect(freshOracle).toEqual(expectedOracle)
  })
})
