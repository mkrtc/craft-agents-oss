import { describe, expect, test } from 'bun:test'
import {
  INITIAL_WHIP_STATE,
  canHandleWhipClick,
  createWhipGuard,
  isInteractiveWhipTarget,
  pickWhipMessageKey,
  shouldCancelOnWhipRightClick,
  whipReducer,
} from '../whip-logic'

describe('whipReducer', () => {
  test('arms from the initial disarmed state', () => {
    expect(whipReducer(INITIAL_WHIP_STATE, { type: 'arm' })).toEqual({ armed: true })
  })

  test('arm is idempotent while already armed', () => {
    const armed = { armed: true }
    expect(whipReducer(armed, { type: 'arm' })).toBe(armed)
  })

  test.each([
    ['disarm' as const],
    ['processing-ended' as const],
    ['session-changed' as const],
    ['timeout' as const],
  ])('%s disarms an armed state', (type) => {
    expect(whipReducer({ armed: true }, { type })).toEqual({ armed: false })
  })

  test.each([
    ['disarm' as const],
    ['processing-ended' as const],
    ['session-changed' as const],
    ['timeout' as const],
  ])('%s is a no-op while already disarmed', (type) => {
    expect(whipReducer(INITIAL_WHIP_STATE, { type })).toBe(INITIAL_WHIP_STATE)
  })
})

describe('createWhipGuard', () => {
  test('fires exactly once until reset', () => {
    const guard = createWhipGuard()
    expect(guard.attempt()).toBe(true)
    expect(guard.attempt()).toBe(false)
    expect(guard.attempt()).toBe(false)
  })

  test('reset allows another single fire', () => {
    const guard = createWhipGuard()
    expect(guard.attempt()).toBe(true)
    guard.reset()
    expect(guard.attempt()).toBe(true)
    expect(guard.attempt()).toBe(false)
  })
})

describe('isInteractiveWhipTarget', () => {
  test('treats null/undefined as non-interactive', () => {
    expect(isInteractiveWhipTarget(null)).toBe(false)
    expect(isInteractiveWhipTarget(undefined)).toBe(false)
  })

  test.each(['a', 'button', 'input', 'textarea', 'select', 'BUTTON'])(
    'treats <%s> as interactive',
    (tagName) => {
      expect(isInteractiveWhipTarget({ tagName })).toBe(true)
    }
  )

  test('treats role="button" as interactive', () => {
    expect(isInteractiveWhipTarget({ tagName: 'div', role: 'button' })).toBe(true)
  })

  test('treats [data-message-action] as interactive', () => {
    expect(isInteractiveWhipTarget({ tagName: 'span', dataset: { messageAction: 'copy' } })).toBe(true)
  })

  test('treats plain message text as non-interactive', () => {
    expect(isInteractiveWhipTarget({ tagName: 'p' })).toBe(false)
    expect(isInteractiveWhipTarget({ tagName: 'div', dataset: {} })).toBe(false)
  })
})

describe('pickWhipMessageKey', () => {
  const keys = ['a', 'b', 'c', 'd']

  test('picks the first key for randomValue 0', () => {
    expect(pickWhipMessageKey(keys, 0)).toBe('a')
  })

  test('picks the last key as randomValue approaches 1', () => {
    expect(pickWhipMessageKey(keys, 0.999999)).toBe('d')
  })

  test('clamps out-of-range random values instead of throwing', () => {
    expect(pickWhipMessageKey(keys, -1)).toBe('a')
    expect(pickWhipMessageKey(keys, 2)).toBe('d')
  })

  test('is deterministic for a given randomValue', () => {
    expect(pickWhipMessageKey(keys, 0.5)).toBe(pickWhipMessageKey(keys, 0.5))
  })

  test('throws when given no keys', () => {
    expect(() => pickWhipMessageKey([], 0.5)).toThrow()
  })
})

describe('canHandleWhipClick', () => {
  test('handles a plain click while armed', () => {
    expect(canHandleWhipClick({ armed: true, isInteractiveTarget: false, hasTextSelection: false })).toBe(true)
  })

  test('is a no-op while disarmed', () => {
    expect(canHandleWhipClick({ armed: false, isInteractiveTarget: false, hasTextSelection: false })).toBe(false)
  })

  test('passes through interactive targets (links/buttons/chips) even when armed', () => {
    expect(canHandleWhipClick({ armed: true, isInteractiveTarget: true, hasTextSelection: false })).toBe(false)
  })

  test('passes through an active text selection even when armed', () => {
    expect(canHandleWhipClick({ armed: true, isInteractiveTarget: false, hasTextSelection: true })).toBe(false)
  })
})

describe('shouldCancelOnWhipRightClick', () => {
  test('cancels while the session is processing', () => {
    expect(shouldCancelOnWhipRightClick({ isProcessing: true })).toBe(true)
  })

  test('does not cancel once processing has ended', () => {
    expect(shouldCancelOnWhipRightClick({ isProcessing: false })).toBe(false)
  })
})

describe('left/right whip click semantics (integration of the pure gates)', () => {
  /** Mirrors ChatDisplay's left-click handler: tease only, never cancels. */
  function simulateLeftClick(params: { armed: boolean; isProcessing: boolean; isInteractiveTarget: boolean; hasTextSelection: boolean }) {
    if (!canHandleWhipClick(params)) return { handled: false, cancelled: false }
    // Left click always shows the tease effect (when armed+processing) but never cancels.
    return { handled: true, cancelled: false }
  }

  /** Mirrors ChatDisplay's right-click handler: cancels once via the one-shot guard. */
  function simulateRightClick(
    params: { armed: boolean; isProcessing: boolean; isInteractiveTarget: boolean; hasTextSelection: boolean },
    guard: ReturnType<typeof createWhipGuard>
  ) {
    if (!canHandleWhipClick(params)) return { handled: false, cancelled: false }
    if (!shouldCancelOnWhipRightClick(params)) return { handled: true, cancelled: false }
    if (!guard.attempt()) return { handled: true, cancelled: false }
    return { handled: true, cancelled: true }
  }

  test('left click while armed and processing never cancels', () => {
    const result = simulateLeftClick({ armed: true, isProcessing: true, isInteractiveTarget: false, hasTextSelection: false })
    expect(result).toEqual({ handled: true, cancelled: false })
  })

  test('left click after processing ended is a safe no-op (no cancel)', () => {
    const result = simulateLeftClick({ armed: true, isProcessing: false, isInteractiveTarget: false, hasTextSelection: false })
    expect(result).toEqual({ handled: true, cancelled: false })
  })

  test('right click while armed and processing cancels exactly once', () => {
    const guard = createWhipGuard()
    const first = simulateRightClick({ armed: true, isProcessing: true, isInteractiveTarget: false, hasTextSelection: false }, guard)
    const second = simulateRightClick({ armed: true, isProcessing: true, isInteractiveTarget: false, hasTextSelection: false }, guard)
    expect(first).toEqual({ handled: true, cancelled: true })
    expect(second).toEqual({ handled: true, cancelled: false })
  })

  test('right click after processing ended does not cancel', () => {
    const guard = createWhipGuard()
    const result = simulateRightClick({ armed: true, isProcessing: false, isInteractiveTarget: false, hasTextSelection: false }, guard)
    expect(result).toEqual({ handled: true, cancelled: false })
  })

  test('interactive targets pass through untouched for both left and right click', () => {
    const guard = createWhipGuard()
    const left = simulateLeftClick({ armed: true, isProcessing: true, isInteractiveTarget: true, hasTextSelection: false })
    const right = simulateRightClick({ armed: true, isProcessing: true, isInteractiveTarget: true, hasTextSelection: false }, guard)
    expect(left).toEqual({ handled: false, cancelled: false })
    expect(right).toEqual({ handled: false, cancelled: false })
  })
})
