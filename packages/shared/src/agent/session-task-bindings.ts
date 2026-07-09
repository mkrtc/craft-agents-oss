/**
 * Session Task Tool Bindings
 *
 * Attaches `taskTools` to a SessionToolContext via a lazy getter backed by the
 * session-scoped callback registry. This mirrors the self-management binding
 * pattern: callbacks may be merged by SessionManager after the agent context is
 * created, and every access resolves the latest registered bundle.
 */

import type { SessionToolContext } from '@craft-agent/session-tools-core';
import { getSessionScopedToolCallbacks } from './session-scoped-tool-callback-registry.ts';

/**
 * Attach task tool callbacks to a SessionToolContext.
 *
 * The property is intentionally undefined when no callbacks are registered so
 * session-tools-core handlers can return their deterministic unavailable errors.
 */
export function attachSessionTaskToolBindings(
  context: SessionToolContext,
  sessionId: string,
): void {
  Object.defineProperty(context, 'taskTools', {
    get() {
      return getSessionScopedToolCallbacks(sessionId)?.taskTools;
    },
    configurable: true,
    enumerable: true,
  });
}
