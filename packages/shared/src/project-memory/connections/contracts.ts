/**
 * Renderer-safe **pure** contract surface for Memory connections.
 *
 * Everything re-exported here is free of transitive Node built-ins
 * (`fs`/`path`/`process`/`crypto`/…): limits, contract types, canonical identity
 * keys, strict validators, DTO *types* + pure mappers, session-ref validators,
 * and UUID *format* helpers. Import this subpath (`@craft-agent/shared/
 * project-memory/contracts`) from renderer/browser-facing code.
 *
 * The backend-only pieces (repository, environment builder, crypto-based
 * derivations, and the detail/snapshot mappers) live in `./index.ts`.
 *
 * The import boundary is guarded by `__tests__/boundary.test.ts`.
 */

export * from './limits.ts';
export * from './types.ts';
export * from './identity.ts';
export * from './validation.ts';
export * from './dto.ts';
export * from './session-refs.ts';
export {
  CANONICAL_UUID_PATTERN,
  UUID_PATTERN,
  isUuid,
  isCanonicalUuid,
  toCanonicalUuid,
  equalUuid,
} from '../../utils/uuid-format.ts';
