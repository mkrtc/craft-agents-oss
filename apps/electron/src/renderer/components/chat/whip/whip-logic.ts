/**
 * Pure state/logic helpers for the Whip click-to-interrupt easter egg.
 * Kept free of React/DOM so it can be unit tested directly.
 */

export const WHIP_ARM_DURATION_MS = 5000

export interface WhipState {
  armed: boolean
}

export type WhipEvent =
  | { type: 'arm' }
  | { type: 'disarm' }
  | { type: 'processing-ended' }
  | { type: 'session-changed' }
  | { type: 'timeout' }

export const INITIAL_WHIP_STATE: WhipState = { armed: false }

export function whipReducer(state: WhipState, event: WhipEvent): WhipState {
  switch (event.type) {
    case 'arm':
      return state.armed ? state : { armed: true }
    case 'disarm':
    case 'processing-ended':
    case 'session-changed':
    case 'timeout':
      return state.armed ? { armed: false } : state
    default:
      return state
  }
}

export interface WhipGuard {
  /** Returns true exactly once per arm cycle; false on every call after that until reset(). */
  attempt: () => boolean
  reset: () => void
}

/** One-shot guard preventing duplicate cancel calls within a single armed window. */
export function createWhipGuard(): WhipGuard {
  let fired = false
  return {
    attempt: () => {
      if (fired) return false
      fired = true
      return true
    },
    reset: () => {
      fired = false
    },
  }
}

export interface WhipTargetInfo {
  tagName?: string | null
  role?: string | null
  dataset?: Record<string, string | undefined>
}

const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'textarea', 'select'])

/**
 * Pure classification used by the DOM click-catcher to decide whether a click
 * landed on an interactive element (link, button, chip, etc.) that should be
 * left alone rather than treated as a whip strike.
 */
export function isInteractiveWhipTarget(info: WhipTargetInfo | null | undefined): boolean {
  if (!info) return false
  const tag = info.tagName?.toLowerCase()
  if (tag && INTERACTIVE_TAGS.has(tag)) return true
  if (info.role === 'button') return true
  if (info.dataset && 'messageAction' in info.dataset) return true
  return false
}

/** Deterministically picks a message key given an injected random value in [0, 1). */
export function pickWhipMessageKey(keys: readonly string[], randomValue: number): string {
  if (keys.length === 0) {
    throw new Error('pickWhipMessageKey requires at least one key')
  }
  const clamped = Math.min(Math.max(randomValue, 0), 0.999999999)
  const index = Math.floor(clamped * keys.length)
  return keys[index]
}

export interface WhipClickGate {
  armed: boolean
  isInteractiveTarget: boolean
  hasTextSelection: boolean
}

/**
 * Shared pass-through gate for both left- and right-click whip handling.
 * A click/context-menu event should be left alone (no animation, no state change,
 * default browser behavior preserved) unless armed and landing on plain chat area.
 */
export function canHandleWhipClick(gate: WhipClickGate): boolean {
  return gate.armed && !gate.isInteractiveTarget && !gate.hasTextSelection
}

/** Right-click only cancels the in-flight turn while the session is still processing. */
export function shouldCancelOnWhipRightClick(params: { isProcessing: boolean }): boolean {
  return params.isProcessing
}
