/**
 * UUID helpers shared across the backend.
 *
 * `UUID_PATTERN` / `isUuid` are pure (regex only) so they can be used at any
 * validation boundary. `randomUuid` and `deterministicUuid` require Node's
 * `crypto` module and are therefore backend-only.
 */

import { createHash, randomUUID } from 'crypto';

/**
 * Canonical RFC-4122 textual UUID (any version/variant), case-insensitive.
 * Accepts both random (v4, from {@link randomUuid}) and derived
 * (v5-shaped, from {@link deterministicUuid}) identifiers.
 */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `value` is a textual UUID. Never throws. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Generate a random (v4) UUID. */
export function randomUuid(): string {
  return randomUUID();
}

/**
 * Derive a stable, deterministic UUID from the given parts.
 *
 * The same parts always produce the same UUID, which lets us mint stable
 * identifiers for derived/synthetic entities (e.g. the environment-compat
 * memory connection, or a connection's derived Global space) without
 * persisting them. The output is a valid RFC-4122 v5-shaped UUID.
 */
export function deterministicUuid(parts: readonly string[]): string {
  const hex = createHash('sha256').update(parts.join('\0')).digest('hex');
  // Force version nibble to 5 and the variant nibble to 8 (RFC-4122).
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
