import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

export interface SetSessionStatusArgs {
  sessionId?: string;
  status: string;
}

export async function handleSetSessionStatus(
  ctx: SessionToolContext,
  args: SetSessionStatusArgs
): Promise<ToolResult> {
  if (!ctx.setSessionStatus) {
    return errorResponse('set_session_status is not available in this context.');
  }

  try {
    // A cross-session update targets a session other than the caller's own.
    // Omitting sessionId (or passing the caller's own id) is a self-update.
    const isCrossSession =
      args.sessionId !== undefined && args.sessionId !== ctx.sessionId;

    // Only orchestrators may drive another session's status. Self-updates are
    // always permitted; cross-session updates require the caller's own session
    // to carry the 'orchestrator' label. If labels are unavailable, be
    // conservative and reject the cross-session change.
    if (isCrossSession) {
      const selfInfo = ctx.getSessionInfo?.(ctx.sessionId);
      const labels = selfInfo?.labels;
      if (!labels) {
        return errorResponse(
          `Cannot verify orchestrator permission (session labels unavailable), so refusing to set the status of another session (${args.sessionId}). Only an orchestrator may change another session's status.`
        );
      }
      if (!labels.includes('orchestrator')) {
        return errorResponse(
          `Refusing to set the status of another session (${args.sessionId}): only an orchestrator (a session labeled "orchestrator") may change another session's status. To update your own status, omit sessionId.`
        );
      }
    }

    let status = args.status;

    // Resolve display name → ID, reject unknown statuses. Closed statuses
    // (done/cancelled) are now permitted — the caller owns closure for its own
    // session, and an orchestrator owns it for sessions it drives.
    if (ctx.resolveStatus) {
      const { resolved, available } = ctx.resolveStatus(status);
      if (!resolved) {
        return errorResponse(
          `Unknown status: "${status}". Available status IDs: ${available.join(', ')}`
        );
      }
      status = resolved;
    }

    await ctx.setSessionStatus(args.sessionId, status);
    const target = args.sessionId ? `session ${args.sessionId}` : 'current session';
    return successResponse(`Status set to "${status}" on ${target}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to set status: ${message}`);
  }
}
