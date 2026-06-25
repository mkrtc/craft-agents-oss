import { describe, expect, test } from 'bun:test'
import {
  shouldAutoExpandTurnActivities,
  shouldUseCompactResponseWindow,
} from '../ChatDisplay.display-rules'

describe('ChatDisplay display rules', () => {
  test('auto-expands turn activities only while the turn is incomplete', () => {
    expect(shouldAutoExpandTurnActivities(true, false)).toBe(true)
    expect(shouldAutoExpandTurnActivities(true, true)).toBe(false)
    expect(shouldAutoExpandTurnActivities(false, false)).toBe(false)
  })

  test('does not auto-expand an active turn after the user collapses it', () => {
    expect(shouldAutoExpandTurnActivities(true, false, true)).toBe(false)
  })

  test('uses full-height response only for the latest response when compact chat window is disabled', () => {
    expect(shouldUseCompactResponseWindow(false, true)).toBe(false)
    expect(shouldUseCompactResponseWindow(false, false)).toBe(true)
    expect(shouldUseCompactResponseWindow(true, true)).toBe(true)
    expect(shouldUseCompactResponseWindow(true, false)).toBe(true)
  })
})
