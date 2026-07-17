import { describe, it, expect } from 'bun:test'
import { sha256 } from '../../sha256'

describe('sha256 (vendored, deterministic)', () => {
  it('matches known-answer vectors', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256('The quick brown fox jumps over the lazy dog')).toBe(
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
    )
  })

  it('handles multi-block (>64 byte) input', () => {
    // 1,000,000 repetitions of "a" — the classic NIST long vector.
    const millionA = 'a'.repeat(1_000_000)
    expect(sha256(millionA)).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0')
  })

  it('is stable across repeated calls', () => {
    const s = 'CRFT-STREAM-V1 determinism check ' + '0123456789'.repeat(50)
    expect(sha256(s)).toBe(sha256(s))
  })
})
