import { createHash } from 'crypto';

export const PROJECT_MEMORY_VECTOR_DIMENSION = 384;

/**
 * Deterministic local embedding used as the MVP fallback when no external
 * embedding provider is configured. It is intentionally simple: token hashes are
 * projected into a fixed vector and L2-normalized. This makes Qdrant usable for
 * lexical/semantic-ish recall without introducing another model dependency.
 */
export function embedProjectMemoryText(text: string, dimension = PROJECT_MEMORY_VECTOR_DIMENSION): number[] {
  const vector = new Array<number>(dimension).fill(0);
  const tokens = text
    .toLowerCase()
    .normalize('NFKC')
    .match(/[\p{L}\p{N}_-]+/gu) ?? [];

  for (const token of tokens) {
    const digest = createHash('sha256').update(token).digest();
    const bucket = digest.readUInt32BE(0) % dimension;
    const sign = ((digest[4] ?? 0) & 1) === 0 ? 1 : -1;
    const weight = 1 + Math.min(token.length, 24) / 24;
    vector[bucket] = (vector[bucket] ?? 0) + sign * weight;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return vector;
  return vector.map(value => value / norm);
}

export function hashProjectMemoryContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function stableProjectMemoryId(parts: string[]): string {
  const hex = createHash('sha256').update(parts.join('\0')).digest('hex');
  // Qdrant accepts UUID strings or unsigned integers as point IDs. Use a stable
  // UUID-shaped value derived from the content hash instead of a raw sha256 hex.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
