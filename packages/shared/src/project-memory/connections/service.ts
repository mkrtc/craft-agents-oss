/**
 * Memory connection service layer.
 *
 * Coordinates MemoryConnectionRepository mutations with CredentialManager memory
 * API-key lifecycle so config and credential state stay consistent.
 */

import { MemoryConnectionRepository } from './repository.ts';
import { toMemoryConnectionSummaryDto, type MemoryConnectionSummaryDto } from './dto.ts';
import type { CreateMemoryConnectionInput, UpdateMemoryConnectionInput, MemoryConnectionConfig } from './types.ts';
import { MemoryError } from './types.ts';
import type { CredentialManager } from '../../credentials/manager.ts';

export interface CreateMemoryConnectionServiceInput extends CreateMemoryConnectionInput {
  /** Optional API key to persist in credentials store. */
  apiKey?: string;
}

export interface UpdateMemoryConnectionServiceInput extends UpdateMemoryConnectionInput {
  /** Connection id to patch. */
  connectionId: string;
  /** Expected per-connection revision for optimistic concurrency. */
  expectedRevision: number;
  /**
   * Optional API key operation:
   * - omit: keep existing key untouched
   * - null: delete the stored key
   * - string: set/replace the stored key
   */
  apiKey?: string | null;
}

export interface MemoryConnectionServiceDeps {
  repository: MemoryConnectionRepository;
  credentialManager: CredentialManager;
}

export type MemoryConnectionServiceCode =
  | 'validation_error'
  | 'config_error'
  | 'credential_error'
  | 'rollback_error'
  | 'not_found';

export class MemoryConnectionServiceError extends Error {
  public readonly code: MemoryConnectionServiceCode;
  public readonly details?: Record<string, unknown>;

  constructor(code: MemoryConnectionServiceCode, message: string, details?: Record<string, unknown>, cause?: unknown) {
    super(message);
    this.name = 'MemoryConnectionServiceError';
    this.code = code;
    this.details = {
      ...(details ?? {}),
      cause: cause instanceof Error ? {
        name: cause.name,
        message: cause.message,
        code: (cause as { code?: unknown }).code,
      } : { message: String(cause) },
    };
  }
}

function normalizeApiKey(raw: string): string {
  const normalized = raw.trim();
  if (normalized.length === 0) {
    throw new MemoryConnectionServiceError('validation_error', 'Memory API key must not be empty');
  }
  return normalized;
}

function serializeCause(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      code: (error as { code?: unknown }).code,
    };
  }
  return { message: String(error) };
}

function mapRepositoryError(error: unknown): never {
  if (error instanceof MemoryConnectionServiceError) throw error;
  if (error instanceof MemoryError) {
    const code = error.code;
    if (code === 'not_found') {
      throw new MemoryConnectionServiceError('not_found', `Failed to load memory connection: ${error.message}`, { cause: serializeCause(error) });
    }
    if (code === 'invalid_input' || code === 'immutable_field' || code === 'duplicate_name') {
      throw new MemoryConnectionServiceError('validation_error', error.message, { cause: serializeCause(error) });
    }
    throw new MemoryConnectionServiceError('config_error', error.message, { cause: serializeCause(error) });
  }

  throw new MemoryConnectionServiceError('config_error', 'Repository operation failed', { cause: serializeCause(error) });
}

function mapCredentialError(error: unknown): never {
  throw new MemoryConnectionServiceError('credential_error', error instanceof Error ? error.message : 'Credential operation failed', {
    cause: serializeCause(error),
  });
}

function pickHasApiKeyFromMode(credentialMode: MemoryConnectionConfig['credentialMode']): boolean {
  return credentialMode === 'stored-api-key';
}

export class MemoryConnectionService {
  public readonly repository: MemoryConnectionRepository;
  public readonly credentialManager: CredentialManager;

  constructor(deps: MemoryConnectionServiceDeps) {
    this.repository = deps.repository;
    this.credentialManager = deps.credentialManager;
  }

  async createConnection(input: CreateMemoryConnectionServiceInput): Promise<MemoryConnectionSummaryDto> {
    const { apiKey, ...connectionInput } = input;
    const normalizedApiKey = apiKey !== undefined ? normalizeApiKey(apiKey) : undefined;
    const expectedRootRevision = this.repository.getRootRevision();
    const credentialMode = normalizedApiKey !== undefined ? 'stored-api-key' : 'none';

    const connection = await this.repository
      .createConnection(connectionInput, expectedRootRevision, { credentialMode })
      .catch((error) => mapRepositoryError(error));

    if (normalizedApiKey === undefined) {
      return toMemoryConnectionSummaryDto(connection, {
        isEnvironment: false,
        hasApiKey: pickHasApiKeyFromMode(connection.credentialMode),
      });
    }

    try {
      await this.credentialManager.setMemoryApiKey(connection.connectionId, normalizedApiKey);
    } catch (error) {
      try {
        const rootAfterCreate = this.repository.getRootRevision();
        await this.repository.deleteConnection(connection.connectionId, rootAfterCreate);
      } catch (rollbackError) {
        throw new MemoryConnectionServiceError('rollback_error', 'Failed to persist API key and rollback connection config', {
          connectionId: connection.connectionId,
          rootRevision: this.repository.getRootRevision(),
          cause: serializeCause(rollbackError),
        });
      }
      mapCredentialError(error);
    }

    return toMemoryConnectionSummaryDto(connection, {
      isEnvironment: false,
      hasApiKey: true,
    });
  }

  async patchConnection(input: UpdateMemoryConnectionServiceInput): Promise<MemoryConnectionSummaryDto> {
    const { connectionId, expectedRevision, apiKey, ...patch } = input;

    const normalizedApiKey = apiKey === undefined
      ? undefined
      : apiKey === null
        ? null
        : normalizeApiKey(apiKey);

    const connection = await this.repository
      .updateConnection(connectionId, patch as UpdateMemoryConnectionInput, expectedRevision)
      .catch((error) => mapRepositoryError(error));

    if (normalizedApiKey === undefined) {
      return toMemoryConnectionSummaryDto(connection, {
        isEnvironment: false,
        hasApiKey: pickHasApiKeyFromMode(connection.credentialMode),
      });
    }

    if (normalizedApiKey === null) {
      try {
        await this.credentialManager.deleteMemoryApiKey(connectionId);
        return toMemoryConnectionSummaryDto(connection, { isEnvironment: false, hasApiKey: false });
      } catch (error) {
        mapCredentialError(error);
      }
    }

    try {
      await this.credentialManager.setMemoryApiKey(connectionId, normalizedApiKey);
      return toMemoryConnectionSummaryDto(connection, { isEnvironment: false, hasApiKey: true });
    } catch (error) {
      mapCredentialError(error);
    }
  }

  async deleteConnection(connectionId: string, expectedRootRevision: number): Promise<void> {
    const existing = this.repository.getConnection(connectionId);
    if (!existing) {
      throw new MemoryConnectionServiceError('not_found', `connection not found: ${connectionId}`);
    }

    let existingKey: string | null = null;
    try {
      existingKey = await this.credentialManager.getMemoryApiKey(connectionId);
    } catch (error) {
      mapCredentialError(error);
    }

    if (existingKey !== null) {
      try {
        const deleted = await this.credentialManager.deleteMemoryApiKey(connectionId);
        if (!deleted) {
          mapCredentialError(new Error('Failed to delete memory API key'));
        }
      } catch (error) {
        mapCredentialError(error);
      }
    }

    try {
      await this.repository.deleteConnection(connectionId, expectedRootRevision);
      return;
    } catch (error) {
      if (existingKey !== null) {
        try {
          await this.credentialManager.setMemoryApiKey(connectionId, existingKey);
        } catch (restoreError) {
          throw new MemoryConnectionServiceError('rollback_error', 'Failed to delete connection and restore API key', {
            connectionId,
            cause: serializeCause(restoreError),
          });
        }
      }
      mapRepositoryError(error);
    }
  }
}
