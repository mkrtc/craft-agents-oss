import type {
  ContentBadge,
  OutboundJournalItemV1,
  OutboundJournalModelAttachmentV1,
  OutboundJournalV1,
  StoredAttachment,
  StoredMessage,
} from '@craft-agent/core/types';

export interface LegacyQueuedMessageMigrationInput {
  sessionId: string;
  messages: readonly StoredMessage[];
  /** Injected to keep migration output deterministic and testable. */
  migratedAt: number;
  existingJournal?: OutboundJournalV1;
}

export interface LegacyQueuedMessageMigrationResult {
  status: 'ok' | 'session_mismatch';
  journal: OutboundJournalV1;
  legacyQueuedMessageIds: string[];
  representedMessageIds: string[];
  createdItemIds: string[];
  skippedMessageIds: string[];
}

export function createEmptyOutboundJournalV1(sessionId: string): OutboundJournalV1 {
  return {
    schemaVersion: 1,
    sessionId,
    paused: false,
    items: [],
  };
}

function cloneBadge(badge: ContentBadge): ContentBadge {
  const cloned: ContentBadge = {
    type: badge.type,
    label: badge.label,
    rawText: badge.rawText,
    start: badge.start,
    end: badge.end,
  };
  if (badge.iconDataUrl !== undefined) cloned.iconDataUrl = badge.iconDataUrl;
  if (badge.collapsedLabel !== undefined) cloned.collapsedLabel = badge.collapsedLabel;
  if (badge.filePath !== undefined) cloned.filePath = badge.filePath;
  return cloned;
}

function cloneStoredAttachment(attachment: StoredAttachment): StoredAttachment {
  const cloned: StoredAttachment = {
    id: attachment.id,
    type: attachment.type,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    storedPath: attachment.storedPath,
  };
  if (attachment.originalSize !== undefined) cloned.originalSize = attachment.originalSize;
  if (attachment.thumbnailPath !== undefined) cloned.thumbnailPath = attachment.thumbnailPath;
  if (attachment.thumbnailBase64 !== undefined) cloned.thumbnailBase64 = attachment.thumbnailBase64;
  if (attachment.markdownPath !== undefined) cloned.markdownPath = attachment.markdownPath;
  if (attachment.wasResized !== undefined) cloned.wasResized = attachment.wasResized;
  if (attachment.resizedBase64 !== undefined) cloned.resizedBase64 = attachment.resizedBase64;
  return cloned;
}

function modelAttachmentFromStored(
  attachment: StoredAttachment,
): OutboundJournalModelAttachmentV1 {
  const modelAttachment: OutboundJournalModelAttachmentV1 = {
    type: attachment.type,
    path: attachment.storedPath,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    storedPath: attachment.storedPath,
  };
  if (attachment.resizedBase64 !== undefined) modelAttachment.base64 = attachment.resizedBase64;
  if (attachment.markdownPath !== undefined) modelAttachment.markdownPath = attachment.markdownPath;
  return modelAttachment;
}

function validTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;
}

function legacyItemId(messageId: string): string {
  return `legacy-queued:${messageId}`;
}

function allocateLegacyItemId(messageId: string, usedItemIds: ReadonlySet<string>): string {
  const baseItemId = legacyItemId(messageId);
  if (!usedItemIds.has(baseItemId)) {
    return baseItemId;
  }

  let collisionIndex = 2;
  let candidate = `${baseItemId}:${collisionIndex}`;
  while (usedItemIds.has(candidate)) {
    collisionIndex += 1;
    candidate = `${baseItemId}:${collisionIndex}`;
  }

  return candidate;
}

/**
 * Conservatively project legacy user messages marked `isQueued` into the v1 journal.
 * The helper never mutates or clears legacy flags; callers may clear them only after
 * the returned journal has crossed its durable persistence barrier.
 */
export function migrateLegacyQueuedMessages(
  input: LegacyQueuedMessageMigrationInput,
): LegacyQueuedMessageMigrationResult {
  const existing = input.existingJournal;
  const journal = existing ?? createEmptyOutboundJournalV1(input.sessionId);
  const legacyQueuedMessageIds: string[] = [];
  const representedMessageIds: string[] = [];
  const createdItemIds: string[] = [];
  const skippedMessageIds: string[] = [];

  const candidates = input.messages.filter((message) => {
    if (message.type !== 'user' || message.isQueued !== true) return false;
    if (typeof message.id !== 'string' || message.id.length === 0) return false;
    if (typeof message.content !== 'string') return false;
    legacyQueuedMessageIds.push(message.id);
    return true;
  });

  if (journal.sessionId !== input.sessionId) {
    skippedMessageIds.push(...legacyQueuedMessageIds);
    return {
      status: 'session_mismatch',
      journal,
      legacyQueuedMessageIds,
      representedMessageIds,
      createdItemIds,
      skippedMessageIds,
    };
  }

  const items = journal.items.slice();
  const representedVisibleIds = new Set(items.map(item => item.visibleMessageId));
  const usedItemIds = new Set(items.map(item => item.itemId));

  for (const message of candidates) {
    if (representedVisibleIds.has(message.id)) {
      representedMessageIds.push(message.id);
      continue;
    }

    const itemId = allocateLegacyItemId(message.id, usedItemIds);

    const storedAttachments = (message.attachments ?? []).map(cloneStoredAttachment);
    const createdAt = validTimestamp(message.timestamp, input.migratedAt);
    const item: OutboundJournalItemV1 = {
      schemaVersion: 1,
      itemId,
      visibleMessageId: message.id,
      text: message.content,
      modelAttachments: storedAttachments.map(modelAttachmentFromStored),
      storedAttachments,
      sendOptions: {
        ...(message.badges ? { badges: message.badges.map(cloneBadge) } : {}),
        ...(message.hidden !== undefined ? { hidden: message.hidden } : {}),
      },
      state: 'queued',
      createdAt,
      updatedAt: input.migratedAt,
      retry: {
        attemptCount: 0,
      },
      migration: {
        source: 'legacy_stored_message_isQueued',
        migratedAt: input.migratedAt,
      },
    };

    items.push(item);
    usedItemIds.add(itemId);
    representedVisibleIds.add(message.id);
    representedMessageIds.push(message.id);
    createdItemIds.push(itemId);
  }

  return {
    status: 'ok',
    journal: {
      schemaVersion: 1,
      sessionId: journal.sessionId,
      paused: journal.paused,
      ...(journal.pauseReason !== undefined ? { pauseReason: journal.pauseReason } : {}),
      items,
    },
    legacyQueuedMessageIds,
    representedMessageIds,
    createdItemIds,
    skippedMessageIds,
  };
}
