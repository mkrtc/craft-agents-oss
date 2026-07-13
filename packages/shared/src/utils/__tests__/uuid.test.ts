import { describe, expect, test } from 'bun:test';
import { isCanonicalUuid, isUuid, randomUuid, toCanonicalUuid, uuidV5 } from '../uuid.ts';

// RFC-4122 DNS namespace.
const DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

describe('uuidV5 (standards-correct, name-based SHA-1)', () => {
  test('matches the well-known RFC test vector for www.example.com', () => {
    // v5(DNS, "www.example.com") is a documented, stable value.
    expect(uuidV5('www.example.com', DNS_NAMESPACE)).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });

  test('is deterministic and produces a canonical v5 UUID', () => {
    const a = uuidV5('example', DNS_NAMESPACE);
    const b = uuidV5('example', DNS_NAMESPACE);
    expect(a).toBe(b);
    expect(isCanonicalUuid(a)).toBe(true);
    expect(a.charAt(14)).toBe('5'); // version nibble
    expect(['8', '9', 'a', 'b']).toContain(a.charAt(19)); // variant nibble
  });

  test('different names / namespaces yield different ids', () => {
    expect(uuidV5('a', DNS_NAMESPACE)).not.toBe(uuidV5('b', DNS_NAMESPACE));
    expect(uuidV5('a', DNS_NAMESPACE)).not.toBe(uuidV5('a', randomUuid()));
  });

  test('throws when the namespace is not a UUID', () => {
    expect(() => uuidV5('x', 'not-a-uuid')).toThrow();
  });
});

describe('uuid format helpers', () => {
  test('randomUuid is canonical lowercase', () => {
    const id = randomUuid();
    expect(isCanonicalUuid(id)).toBe(true);
    expect(id).toBe(id.toLowerCase());
  });

  test('isUuid accepts case variants; isCanonicalUuid does not', () => {
    const upper = randomUuid().toUpperCase();
    expect(isUuid(upper)).toBe(true);
    expect(isCanonicalUuid(upper)).toBe(false);
    expect(toCanonicalUuid(upper)).toBe(upper.toLowerCase());
    expect(toCanonicalUuid('nope')).toBeNull();
  });
});
