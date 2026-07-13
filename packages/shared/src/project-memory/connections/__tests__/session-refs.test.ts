import { describe, expect, test } from 'bun:test';
import { randomUuid } from '../../../utils/uuid.ts';
import { MEMORY_LIMITS } from '../limits.ts';
import {
  validateMemorySpaceRef,
  validateSessionMemorySpaceRefs,
  validateSessionMemoryWriteTarget,
} from '../session-refs.ts';

const CONN = '123e4567-e89b-42d3-8456-426614174000';
const SPACE_A = 'aaaaaaaa-e89b-42d3-8456-426614174000';
const SPACE_B = 'bbbbbbbb-e89b-42d3-8456-426614174000';

describe('validateMemorySpaceRef', () => {
  test('canonicalizes both ids to lowercase', () => {
    const result = validateMemorySpaceRef({ connectionId: CONN.toUpperCase(), spaceId: SPACE_A.toUpperCase() });
    expect(result.valid).toBe(true);
    expect(result.value).toEqual({ connectionId: CONN, spaceId: SPACE_A });
  });

  test('rejects unknown fields and non-UUID ids', () => {
    expect(validateMemorySpaceRef({ connectionId: CONN, spaceId: SPACE_A, extra: 1 }).valid).toBe(false);
    expect(validateMemorySpaceRef({ connectionId: 'nope', spaceId: SPACE_A }).valid).toBe(false);
    expect(validateMemorySpaceRef({ connectionId: CONN }).valid).toBe(false);
    expect(validateMemorySpaceRef(null).valid).toBe(false);
  });
});

describe('validateSessionMemorySpaceRefs', () => {
  test('canonically orders refs and is order-independent (canonical serialization)', () => {
    const forward = validateSessionMemorySpaceRefs([{ connectionId: CONN, spaceId: SPACE_B }, { connectionId: CONN, spaceId: SPACE_A }]);
    const reverse = validateSessionMemorySpaceRefs([{ connectionId: CONN, spaceId: SPACE_A }, { connectionId: CONN, spaceId: SPACE_B }]);
    expect(forward.valid).toBe(true);
    expect(forward.value).toEqual([{ connectionId: CONN, spaceId: SPACE_A }, { connectionId: CONN, spaceId: SPACE_B }]);
    expect(JSON.stringify(forward.value)).toBe(JSON.stringify(reverse.value));
  });

  test('rejects duplicate (connection+space) refs', () => {
    const result = validateSessionMemorySpaceRefs([{ connectionId: CONN, spaceId: SPACE_A }, { connectionId: CONN, spaceId: SPACE_A }]);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('duplicate');
  });

  test('enforces the max-refs bound', () => {
    const ok = Array.from({ length: MEMORY_LIMITS.MAX_SESSION_SPACE_REFS }, () => ({ connectionId: CONN, spaceId: randomUuid() }));
    expect(validateSessionMemorySpaceRefs(ok).valid).toBe(true);
    const tooMany = Array.from({ length: MEMORY_LIMITS.MAX_SESSION_SPACE_REFS + 1 }, () => ({ connectionId: CONN, spaceId: randomUuid() }));
    expect(validateSessionMemorySpaceRefs(tooMany).valid).toBe(false);
  });

  test('rejects a non-array', () => {
    expect(validateSessionMemorySpaceRefs({} as unknown).valid).toBe(false);
  });
});

describe('validateSessionMemoryWriteTarget', () => {
  test('validates and canonicalizes a single ref', () => {
    const result = validateSessionMemoryWriteTarget({ connectionId: CONN, spaceId: SPACE_A });
    expect(result.valid).toBe(true);
    expect(result.value).toEqual({ connectionId: CONN, spaceId: SPACE_A });
  });
});
