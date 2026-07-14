/**
 * Thin DOM glue for the Whip click-catcher. Kept separate from whip-logic.ts
 * so the pure classification/state logic stays unit-testable without a DOM.
 */

const INTERACTIVE_SELECTOR = 'a, button, input, textarea, select, [role="button"], [data-message-action]'

/** True if the click target is (or is inside) an interactive element that should pass through untouched. */
export function isInteractiveEventTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof Element)) return false
  return target.closest(INTERACTIVE_SELECTOR) !== null
}

/** True if the user currently has a non-empty text selection (avoid hijacking select/copy gestures). */
export function hasActiveTextSelection(): boolean {
  if (typeof window === 'undefined' || typeof window.getSelection !== 'function') return false
  const selection = window.getSelection()
  return !!selection && selection.type === 'Range' && selection.toString().length > 0
}

/**
 * Neutral targeting cursor used while the whip is armed. A plain crosshair (no
 * custom SVG/colored image) so nothing colored appears to replace the pointer.
 */
export const WHIP_CURSOR_STYLE = "crosshair"
