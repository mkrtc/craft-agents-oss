/**
 * Strict, pure validation and canonical reconstruction for a session's Memory
 * space selection (`enabledMemorySpaceRefs` read set + `memoryWriteTargetRef`).
 *
 * Pure module (no Node built-ins). This is the single funnel that untrusted
 * session persistence / transfer bundles pass through:
 * - every ref is `{ connectionId, spaceId }` with both ids canonicalized to
 *   lowercase UUIDs;
 * - unknown fields are rejected;
 * - duplicate (connection+space) refs are rejected (duplicate policy);
 * - the read set is bounded to `MEMORY_LIMITS.MAX_SESSION_SPACE_REFS` (50);
 * - the reconstructed list is deterministically ordered (canonical
 *   serialization), so equal selections serialize identically.
 *
 * Lifecycle authorization (whether the referenced space still exists / is
 * writable / is bound to the session's project) is Wave C and intentionally NOT
 * done here — this module only enforces the structural/canonical contract.
 */

import { toCanonicalUuid } from '../../utils/uuid-format.ts';
import { MEMORY_LIMITS } from './limits.ts';
import type { MemorySpaceRef } from './types.ts';
import type { ValidationResult } from './validation.ts';

const REF_KEYS = new Set(['connectionId', 'spaceId']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refKey(ref: MemorySpaceRef): string {
  return `${ref.connectionId}\u0000${ref.spaceId}`;
}

/**
 * Validate and canonicalize a single space ref. Both ids are normalized to
 * canonical lowercase UUIDs; unknown fields are rejected.
 */
export function validateMemorySpaceRef(input: unknown, label = 'memory space ref'): ValidationResult<MemorySpaceRef> {
  const errors: string[] = [];
  if (!isPlainObject(input)) {
    return { valid: false, errors: [`${label} must be an object`] };
  }
  const extras = Object.keys(input).filter(k => !REF_KEYS.has(k));
  if (extras.length > 0) errors.push(`${label} has unknown field(s): ${extras.join(', ')}`);

  const connectionId = toCanonicalUuid(input.connectionId);
  const spaceId = toCanonicalUuid(input.spaceId);
  if (connectionId === null) errors.push(`${label}.connectionId must be a UUID`);
  if (spaceId === null) errors.push(`${label}.spaceId must be a UUID`);

  if (errors.length > 0 || connectionId === null || spaceId === null) {
    return { valid: false, errors };
  }
  return { valid: true, value: { connectionId, spaceId }, errors };
}

/** Deterministic canonical ordering for refs: connectionId, then spaceId. */
function sortRefs(refs: MemorySpaceRef[]): MemorySpaceRef[] {
  return [...refs].sort((a, b) =>
    a.connectionId.localeCompare(b.connectionId) || a.spaceId.localeCompare(b.spaceId));
}

/**
 * Validate and canonically reconstruct a session's read-set refs.
 * Rejects duplicates and enforces the max-refs bound.
 */
export function validateSessionMemorySpaceRefs(input: unknown): ValidationResult<MemorySpaceRef[]> {
  if (!Array.isArray(input)) {
    return { valid: false, errors: ['enabledMemorySpaceRefs must be an array'] };
  }
  const errors: string[] = [];
  if (input.length > MEMORY_LIMITS.MAX_SESSION_SPACE_REFS) {
    errors.push(`a session may enable at most ${MEMORY_LIMITS.MAX_SESSION_SPACE_REFS} memory spaces`);
  }
  const seen = new Set<string>();
  const refs: MemorySpaceRef[] = [];
  for (let i = 0; i < input.length; i++) {
    const result = validateMemorySpaceRef(input[i], `enabledMemorySpaceRefs[${i}]`);
    if (!result.valid || !result.value) {
      errors.push(...result.errors);
      continue;
    }
    const key = refKey(result.value);
    if (seen.has(key)) {
      errors.push(`duplicate memory space ref: ${result.value.connectionId}/${result.value.spaceId}`);
      continue;
    }
    seen.add(key);
    refs.push(result.value);
  }
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value: sortRefs(refs), errors };
}

/** Validate and canonicalize a session's single write-target ref. */
export function validateSessionMemoryWriteTarget(input: unknown): ValidationResult<MemorySpaceRef> {
  return validateMemorySpaceRef(input, 'memoryWriteTargetRef');
}
