import { describe, it, expect } from 'bun:test';
import { handleSetSessionStatus } from './set-session-status.ts';
import type { SessionToolContext, SessionInfo } from '../context.ts';

type StatusEntry = { id: string; label: string; category: 'open' | 'closed' };

const STATUSES: StatusEntry[] = [
  { id: 'todo', label: 'Todo', category: 'open' },
  { id: 'in-progress', label: 'In Progress', category: 'open' },
  { id: 'needs-review', label: 'Needs Review', category: 'open' },
  { id: 'done', label: 'Done', category: 'closed' },
  { id: 'cancelled', label: 'Cancelled', category: 'closed' },
];

const SELF_ID = 'session-self';

interface CtxOptions {
  /** Labels on the caller's own session. `null` simulates labels being unavailable. */
  selfLabels?: string[] | null;
}

function createCtx(options: CtxOptions = {}): {
  ctx: SessionToolContext;
  sets: Array<{ sessionId?: string; status: string }>;
} {
  const { selfLabels = [] } = options;
  const sets: Array<{ sessionId?: string; status: string }> = [];
  const ctx = {
    sessionId: SELF_ID,
    setSessionStatus: (sessionId: string | undefined, status: string) => {
      sets.push({ sessionId, status });
    },
    getSessionInfo: (sessionId?: string): SessionInfo | null => {
      if (selfLabels === null) return null;
      return {
        id: sessionId ?? SELF_ID,
        name: 'Self',
        labels: selfLabels,
        status: 'todo',
        permissionMode: 'allow-all',
        createdAt: 0,
        isActive: true,
      };
    },
    resolveStatus: (input: string) => {
      const available = STATUSES.map((s) => s.id);
      const hit =
        STATUSES.find((s) => s.id === input) ??
        STATUSES.find((s) => s.label.toLowerCase() === input.toLowerCase());
      return hit ? { resolved: hit.id, available, category: hit.category } : { resolved: null, available };
    },
  } as unknown as SessionToolContext;
  return { ctx, sets };
}

describe('handleSetSessionStatus — self status changes', () => {
  it('allows setting an open status on your own session', async () => {
    const { ctx, sets } = createCtx();
    const result = await handleSetSessionStatus(ctx, { status: 'needs-review' });
    expect(result.isError).toBeFalsy();
    expect(sets).toEqual([{ sessionId: undefined, status: 'needs-review' }]);
  });

  it('allows setting a closed status (done) on your own session', async () => {
    const { ctx, sets } = createCtx();
    const result = await handleSetSessionStatus(ctx, { status: 'done' });
    expect(result.isError).toBeFalsy();
    expect(sets).toEqual([{ sessionId: undefined, status: 'done' }]);
  });

  it('resolves a display label to its ID for a closed status (Cancelled → cancelled)', async () => {
    const { ctx, sets } = createCtx();
    const result = await handleSetSessionStatus(ctx, { status: 'Cancelled' });
    expect(result.isError).toBeFalsy();
    expect(sets).toEqual([{ sessionId: undefined, status: 'cancelled' }]);
  });

  it('treats passing your own sessionId as a self-update (closed status allowed)', async () => {
    const { ctx, sets } = createCtx();
    const result = await handleSetSessionStatus(ctx, { sessionId: SELF_ID, status: 'done' });
    expect(result.isError).toBeFalsy();
    expect(sets).toEqual([{ sessionId: SELF_ID, status: 'done' }]);
  });

  it('still rejects an unknown status', async () => {
    const { ctx, sets } = createCtx();
    const result = await handleSetSessionStatus(ctx, { status: 'banana' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Unknown status');
    expect(sets).toHaveLength(0);
  });
});

describe('handleSetSessionStatus — cross-session status changes', () => {
  it('rejects a non-orchestrator setting another session status', async () => {
    const { ctx, sets } = createCtx({ selfLabels: ['bug'] });
    const result = await handleSetSessionStatus(ctx, { sessionId: 'other-session', status: 'in-progress' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('orchestrator');
    expect(sets).toHaveLength(0);
  });

  it('allows an orchestrator to set another session status', async () => {
    const { ctx, sets } = createCtx({ selfLabels: ['orchestrator'] });
    const result = await handleSetSessionStatus(ctx, { sessionId: 'other-session', status: 'done' });
    expect(result.isError).toBeFalsy();
    expect(sets).toEqual([{ sessionId: 'other-session', status: 'done' }]);
  });

  it('rejects a cross-session change when labels are unavailable', async () => {
    const { ctx, sets } = createCtx({ selfLabels: null });
    const result = await handleSetSessionStatus(ctx, { sessionId: 'other-session', status: 'in-progress' });
    expect(result.isError).toBe(true);
    expect(sets).toHaveLength(0);
  });
});
