import type {
  AuthRequestType,
  ContentBadge,
  CredentialInputMode,
  StoredAttachment,
} from './message.ts';
import type { RuntimeErrorCode } from './runtime-lifecycle.ts';

/** Versioned copy of the model-facing attachment data needed for durable replay. */
export interface OutboundJournalModelAttachmentV1 {
  type: 'image' | 'text' | 'pdf' | 'office' | 'audio' | 'unknown';
  path: string;
  name: string;
  mimeType: string;
  base64?: string;
  text?: string;
  size: number;
  storedPath?: string;
  markdownPath?: string;
}

/** Exact v1 snapshot of every current SendMessageOptions field. */
export interface OutboundJournalSendOptionsV1 {
  skillSlugs?: string[];
  badges?: ContentBadge[];
  optimisticMessageId?: string;
  hidden?: boolean;
}

export type OutboundJournalItemState =
  | 'queued'
  | 'claimed'
  | 'active'
  | 'completed'
  | 'retryable_failed';

export interface OutboundJournalClaimV1 {
  claimToken: string;
  turnGeneration: number;
  runtimeEpoch: number;
  agentIdentity: string;
  turnToken: string;
  claimedAt: number;
}

export interface OutboundJournalRetryMetadataV1 {
  attemptCount: number;
  lastAttemptAt?: number;
  lastErrorCode?: RuntimeErrorCode;
  /** The only proof that permits automatic replay after invocation uncertainty. */
  dispatchProof?: 'not_dispatched';
}

export interface OutboundJournalItemV1 {
  schemaVersion: 1;
  itemId: string;
  visibleMessageId: string;
  text: string;
  modelAttachments: OutboundJournalModelAttachmentV1[];
  storedAttachments: StoredAttachment[];
  sendOptions: OutboundJournalSendOptionsV1;
  state: OutboundJournalItemState;
  createdAt: number;
  updatedAt: number;
  claim?: OutboundJournalClaimV1;
  retry: OutboundJournalRetryMetadataV1;
  migration?: {
    source: 'legacy_stored_message_isQueued';
    migratedAt: number;
  };
}

export type OutboundJournalPauseReason =
  | 'retryable_failed'
  | 'post_dispatch_auth_failure'
  | 'backend_crash'
  | 'watchdog'
  | 'shutdown'
  | 'user_stop'
  | 'permission_expired'
  | 'runtime_lease_expired';

/**
 * Per-session durable FIFO state. This is designed for a separate runtime-state
 * document rather than the size-limited JSONL list-view header.
 */
export interface OutboundJournalV1 {
  schemaVersion: 1;
  sessionId: string;
  paused: boolean;
  pauseReason?: OutboundJournalPauseReason;
  items: OutboundJournalItemV1[];
}

interface DurableHandoffBaseV1 {
  schemaVersion: 1;
  handoffToken: string;
  sessionId: string;
  runtimeEpoch: number;
  turnGeneration: number;
  agentIdentity: string;
  turnToken: string;
  state: 'pending' | 'resolved' | 'expired' | 'cancelled';
  createdAt: number;
  updatedAt: number;
}

export interface DurablePlanHandoffV1 extends DurableHandoffBaseV1 {
  kind: 'plan';
  planPath: string;
  visibleMessageId: string;
}

export interface DurableAuthHandoffV1 extends DurableHandoffBaseV1 {
  kind: 'auth';
  requestId: string;
  requestType: AuthRequestType;
  sourceSlug?: string;
  sourceName?: string;
  credentialMode?: CredentialInputMode;
  headerName?: string;
  headerNames?: string[];
  labels?: {
    credential?: string;
    username?: string;
    password?: string;
  };
  description?: string;
  hint?: string;
  sourceUrl?: string;
  passwordRequired?: boolean;
  visibleMessageId: string;
}

export type DurableHandoffRecordV1 = DurablePlanHandoffV1 | DurableAuthHandoffV1;

export interface DurableHandoffStoreV1 {
  schemaVersion: 1;
  sessionId: string;
  records: DurableHandoffRecordV1[];
}

/** Root schema for future atomic per-session runtime persistence. */
export interface SessionRuntimePersistenceV1 {
  schemaVersion: 1;
  sessionId: string;
  outboundJournal: OutboundJournalV1;
  handoffs: DurableHandoffStoreV1;
}
