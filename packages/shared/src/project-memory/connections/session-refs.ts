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
import type { MemorySelectionMode, MemorySpaceRef } from './types.ts';
import type { ValidationResult } from './validation.ts';

const REF_KEYS = new Set(['connectionId', 'spaceId']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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

  const connectionId = Object.hasOwn(input, 'connectionId') ? toCanonicalUuid(input.connectionId) : null;
  const spaceId = Object.hasOwn(input, 'spaceId') ? toCanonicalUuid(input.spaceId) : null;
  if (connectionId === null) errors.push(`${label}.connectionId must be an own UUID property`);
  if (spaceId === null) errors.push(`${label}.spaceId must be an own UUID property`);

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
  // Reject over-limit input before examining nested values. This keeps hostile
  // persisted/bundle input bounded even when every element is malformed.
  if (input.length > MEMORY_LIMITS.MAX_SESSION_SPACE_REFS) {
    return {
      valid: false,
      errors: [`a session may enable at most ${MEMORY_LIMITS.MAX_SESSION_SPACE_REFS} memory spaces`],
    };
  }
  const errors: string[] = [];
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

/**
 * Structurally valid, canonical Memory selection fields suitable for session
 * persistence. The fields remain independently optional for compatibility:
 * absent selection state keeps legacy/default resolution, while a write target
 * is only structurally validated here. Lifecycle authorization belongs to the
 * session resolver, not this pure persistence boundary.
 */
export interface SessionMemorySelection {
  enabledMemorySpaceRefs?: MemorySpaceRef[];
  memoryWriteTargetRef?: MemorySpaceRef;
  memorySelectionMode?: MemorySelectionMode;
}

const SELECTION_KEYS = new Set([
  'enabledMemorySpaceRefs',
  'memoryWriteTargetRef',
  'memorySelectionMode',
]);

/**
 * Strict, pure combined normalizer for all persisted session Memory selection
 * fields. It never mutates input and returns reconstructed refs only.
 */
export function normalizeSessionMemorySelection(input: unknown): ValidationResult<SessionMemorySelection> {
  if (!isPlainObject(input)) {
    return { valid: false, errors: ['memory selection must be an object'] };
  }

  const errors: string[] = [];
  const extras = Object.keys(input).filter(key => !SELECTION_KEYS.has(key));
  if (extras.length > 0) errors.push(`memory selection has unknown field(s): ${extras.join(', ')}`);

  const selection: SessionMemorySelection = {};
  if (Object.hasOwn(input, 'enabledMemorySpaceRefs')) {
    const refs = validateSessionMemorySpaceRefs(input.enabledMemorySpaceRefs);
    if (!refs.valid || !refs.value) errors.push(...refs.errors);
    else selection.enabledMemorySpaceRefs = refs.value;
  }

  if (Object.hasOwn(input, 'memoryWriteTargetRef')) {
    const target = validateSessionMemoryWriteTarget(input.memoryWriteTargetRef);
    if (!target.valid || !target.value) errors.push(...target.errors);
    else selection.memoryWriteTargetRef = target.value;
  }

  if (Object.hasOwn(input, 'memorySelectionMode')) {
    if (input.memorySelectionMode !== 'explicit') {
      errors.push('memorySelectionMode must be "explicit" when present');
    } else {
      selection.memorySelectionMode = 'explicit';
    }
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value: selection, errors };
}
