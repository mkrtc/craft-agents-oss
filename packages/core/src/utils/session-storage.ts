/**
 * Maximum UTF-8 byte length of the first JSONL session-header line.
 *
 * This contract is browser-safe and shared by all Node persistence/readers so
 * producers and consumers cannot silently drift to different limits.
 */
export const MAX_SESSION_HEADER_BYTES = 64 * 1024;
