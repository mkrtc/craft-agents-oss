import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  OutboundJournalV1,
  SessionRuntimePersistenceV1,
} from '@craft-agent/core/types';
import { readSessionJsonl } from '../jsonl.ts';
import {
  createEmptyOutboundJournalV1,
  migrateLegacyQueuedMessages,
} from '../runtime-persistence.ts';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function header(sessionId: string): Record<string, unknown> {
  return {
    id: sessionId,
    workspaceRootPath: '/tmp/ws',
    createdAt: 1,
    lastUsedAt: 2,
    messageCount: 0,
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
    },
  };
}

describe('runtime persistence schema foundation', () => {
  it('reads legacy isQueued data and migrates replay metadata conservatively', () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'runtime-persistence-'));
    tempDirs.push(sessionDir);
    const sessionFile = join(sessionDir, 'session.jsonl');

    const queuedMessage = {
      id: 'm-queued',
      type: 'user',
      content: 'queued text',
      timestamp: 100,
      isQueued: true,
      hidden: true,
      badges: [{
        type: 'skill',
        label: 'Audit',
        rawText: '[skill:audit]',
        start: 0,
        end: 13,
        iconDataUrl: 'data:image/png;base64,icon',
      }],
      attachments: [{
        id: 'stored-1',
        type: 'image',
        name: 'image.png',
        mimeType: 'image/png',
        size: 12,
        originalSize: 20,
        storedPath: '/tmp/ws/sessions/s1/attachments/image.png',
        thumbnailPath: '/tmp/ws/sessions/s1/attachments/thumb.png',
        thumbnailBase64: 'thumb-data',
        wasResized: true,
        resizedBase64: 'resized-data',
      }],
      unexpectedLegacyField: 'must-not-propagate',
    };
    const nonQueuedMessage = {
      id: 'm-normal',
      type: 'user',
      content: 'normal text',
      timestamp: 101,
    };

    writeFileSync(
      sessionFile,
      `${JSON.stringify(header('s1'))}\n${JSON.stringify(queuedMessage)}\n${JSON.stringify(nonQueuedMessage)}\n`,
      'utf-8',
    );

    const loaded = readSessionJsonl(sessionFile);
    expect(loaded?.messages[0]?.isQueued).toBe(true);

    const result = migrateLegacyQueuedMessages({
      sessionId: 's1',
      messages: loaded!.messages,
      migratedAt: 200,
    });

    expect(result.status).toBe('ok');
    expect(result.legacyQueuedMessageIds).toEqual(['m-queued']);
    expect(result.representedMessageIds).toEqual(['m-queued']);
    expect(result.createdItemIds).toEqual(['legacy-queued:m-queued']);
    expect(result.skippedMessageIds).toEqual([]);
    expect(result.journal.items).toHaveLength(1);
    expect(result.journal.items[0]).toEqual({
      schemaVersion: 1,
      itemId: 'legacy-queued:m-queued',
      visibleMessageId: 'm-queued',
      text: 'queued text',
      modelAttachments: [{
        type: 'image',
        path: '/tmp/ws/sessions/s1/attachments/image.png',
        name: 'image.png',
        mimeType: 'image/png',
        size: 12,
        storedPath: '/tmp/ws/sessions/s1/attachments/image.png',
        base64: 'resized-data',
      }],
      storedAttachments: [{
        id: 'stored-1',
        type: 'image',
        name: 'image.png',
        mimeType: 'image/png',
        size: 12,
        originalSize: 20,
        storedPath: '/tmp/ws/sessions/s1/attachments/image.png',
        thumbnailPath: '/tmp/ws/sessions/s1/attachments/thumb.png',
        thumbnailBase64: 'thumb-data',
        wasResized: true,
        resizedBase64: 'resized-data',
      }],
      sendOptions: {
        badges: [{
          type: 'skill',
          label: 'Audit',
          rawText: '[skill:audit]',
          start: 0,
          end: 13,
          iconDataUrl: 'data:image/png;base64,icon',
        }],
        hidden: true,
      },
      state: 'queued',
      createdAt: 100,
      updatedAt: 200,
      retry: { attemptCount: 0 },
      migration: {
        source: 'legacy_stored_message_isQueued',
        migratedAt: 200,
      },
    });

    // Migration cannot clear the legacy marker before the new journal is durable.
    expect(loaded?.messages[0]?.isQueued).toBe(true);
    expect(JSON.stringify(result.journal)).not.toContain('must-not-propagate');
  });

  it('is idempotent after the journal has been serialized and reloaded', () => {
    const messages = [{
      id: 'm1',
      type: 'user' as const,
      content: 'hello',
      timestamp: 10,
      isQueued: true,
    }];

    const first = migrateLegacyQueuedMessages({
      sessionId: 's1',
      messages,
      migratedAt: 20,
    });
    const reloaded = JSON.parse(JSON.stringify(first.journal)) as OutboundJournalV1;
    const second = migrateLegacyQueuedMessages({
      sessionId: 's1',
      messages,
      migratedAt: 30,
      existingJournal: reloaded,
    });

    expect(second.status).toBe('ok');
    expect(second.createdItemIds).toEqual([]);
    expect(second.representedMessageIds).toEqual(['m1']);
    expect(second.journal).toEqual(reloaded);
  });

  it('allocates a deterministic collision-safe item id when the legacy id is already taken', () => {
    const result = migrateLegacyQueuedMessages({
      sessionId: 's1',
      messages: [{
        id: 'm1',
        type: 'user',
        content: 'queued hello',
        timestamp: 10,
        isQueued: true,
      }],
      migratedAt: 20,
      existingJournal: {
        schemaVersion: 1,
        sessionId: 's1',
        paused: false,
        items: [{
          schemaVersion: 1,
          itemId: 'legacy-queued:m1',
          visibleMessageId: 'different-visible-message',
          text: 'already present',
          modelAttachments: [],
          storedAttachments: [],
          sendOptions: {},
          state: 'queued',
          createdAt: 1,
          updatedAt: 1,
          retry: { attemptCount: 0 },
        }],
      },
    });

    expect(result.status).toBe('ok');
    expect(result.createdItemIds).toEqual(['legacy-queued:m1:2']);
    expect(result.representedMessageIds).toEqual(['m1']);
    expect(result.skippedMessageIds).toEqual([]);
    expect(result.journal.items).toHaveLength(2);
    expect(result.journal.items[1]).toMatchObject({
      itemId: 'legacy-queued:m1:2',
      visibleMessageId: 'm1',
      text: 'queued hello',
      state: 'queued',
      createdAt: 10,
      updatedAt: 20,
      migration: {
        source: 'legacy_stored_message_isQueued',
        migratedAt: 20,
      },
    });
  });

  it('refuses to merge an existing journal from another session', () => {
    const foreign = createEmptyOutboundJournalV1('other-session');
    const result = migrateLegacyQueuedMessages({
      sessionId: 's1',
      messages: [{
        id: 'm1',
        type: 'user',
        content: 'hello',
        isQueued: true,
      }],
      migratedAt: 20,
      existingJournal: foreign,
    });

    expect(result.status).toBe('session_mismatch');
    expect(result.journal).toBe(foreign);
    expect(result.createdItemIds).toEqual([]);
    expect(result.skippedMessageIds).toEqual(['m1']);
  });

  it('round-trips full v1 journal options, attachment data, identities, and durable handoffs', () => {
    const document: SessionRuntimePersistenceV1 = {
      schemaVersion: 1,
      sessionId: 's1',
      outboundJournal: {
        schemaVersion: 1,
        sessionId: 's1',
        paused: true,
        pauseReason: 'retryable_failed',
        items: [{
          schemaVersion: 1,
          itemId: 'item-1',
          visibleMessageId: 'message-1',
          text: 'full replay text',
          modelAttachments: [{
            type: 'text',
            path: '/stored/a.txt',
            name: 'a.txt',
            mimeType: 'text/plain',
            text: 'attachment body',
            size: 15,
            storedPath: '/stored/a.txt',
          }],
          storedAttachments: [{
            id: 'attachment-1',
            type: 'text',
            name: 'a.txt',
            mimeType: 'text/plain',
            size: 15,
            storedPath: '/stored/a.txt',
          }],
          sendOptions: {
            skillSlugs: ['audit'],
            badges: [{
              type: 'skill',
              label: 'Audit',
              rawText: '[skill:audit]',
              start: 0,
              end: 13,
            }],
            optimisticMessageId: 'optimistic-1',
            hidden: true,
          },
          state: 'claimed',
          createdAt: 1,
          updatedAt: 2,
          claim: {
            claimToken: 'claim-1',
            turnGeneration: 3,
            runtimeEpoch: 4,
            agentIdentity: 'agent-1',
            turnToken: 'turn-1',
            claimedAt: 2,
          },
          retry: {
            attemptCount: 1,
            lastAttemptAt: 2,
            lastErrorCode: 'runtime_backend_crashed',
            dispatchProof: 'not_dispatched',
          },
        }],
      },
      handoffs: {
        schemaVersion: 1,
        sessionId: 's1',
        records: [
          {
            schemaVersion: 1,
            kind: 'plan',
            handoffToken: 'handoff-plan',
            sessionId: 's1',
            runtimeEpoch: 4,
            turnGeneration: 3,
            agentIdentity: 'agent-1',
            turnToken: 'turn-1',
            state: 'pending',
            createdAt: 3,
            updatedAt: 3,
            planPath: '/plans/final.md',
            visibleMessageId: 'plan-message',
          },
          {
            schemaVersion: 1,
            kind: 'auth',
            handoffToken: 'handoff-auth',
            sessionId: 's1',
            runtimeEpoch: 4,
            turnGeneration: 3,
            agentIdentity: 'agent-1',
            turnToken: 'turn-1',
            state: 'pending',
            createdAt: 4,
            updatedAt: 4,
            requestId: 'auth-request-1',
            requestType: 'credential',
            sourceSlug: 'example',
            sourceName: 'Example',
            credentialMode: 'multi-header',
            headerNames: ['X-API-Key', 'X-App-Key'],
            labels: { credential: 'API key' },
            description: 'Authenticate the source',
            hint: 'Use the source settings page',
            sourceUrl: 'https://example.com',
            passwordRequired: false,
            visibleMessageId: 'auth-message',
          },
        ],
      },
    };

    expect(JSON.parse(JSON.stringify(document))).toEqual(document);
  });
});
