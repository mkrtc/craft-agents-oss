/**
 * Pure UUID *format* helpers.
 *
 * This module is intentionally free of Node built-ins (no `crypto`), so it can
 * be imported by renderer-facing / browser-safe contract code without pulling
 * `crypto` into the bundle. UUID *generation* (which needs `crypto`) lives in
 * the backend-only `./uuid.ts`.
 */

/**
 * Canonical RFC-4122 textual UUID, **lowercase only** (any version/variant).
 * We store and compare UUIDs in canonical lowercase form everywhere, so this is
 * the pattern used for stored/persisted identifiers.
 */
export const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Case-insensitive textual UUID. Accepts upper/lower case; use only at trust
 * boundaries where a caller may hand us a non-canonical UUID that we then
 * canonicalize via {@link toCanonicalUuid}.
 */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `value` is a textual UUID (any case). Never throws. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** True when `value` is a *canonical* (lowercase) textual UUID. Never throws. */
export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_UUID_PATTERN.test(value);
}

/**
 * Canonicalize a UUID to lowercase, or return `null` if it is not a UUID.
 * This is the single funnel through which every UUID entering the system is
 * normalized, so a case-variant (`ABCDEF…`) can never masquerade as a distinct
 * identifier from its lowercase form.
 */
export function toCanonicalUuid(value: unknown): string | null {
  return isUuid(value) ? (value as string).toLowerCase() : null;
}

/** Whether two values are the same UUID irrespective of case. Never throws. */
export function equalUuid(a: unknown, b: unknown): boolean {
  const ca = toCanonicalUuid(a);
  const cb = toCanonicalUuid(b);
  return ca !== null && ca === cb;
}
