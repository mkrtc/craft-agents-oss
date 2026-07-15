import { describe, expect, it } from 'bun:test';
import {
  RUNTIME_LIFECYCLE_CORRELATION_MAX_CHARS,
  RUNTIME_LIFECYCLE_EVENT_MAX_BYTES,
  serializeRuntimeLifecycleEvent,
  toRuntimeLifecycleEvent,
} from '../runtime-lifecycle-serializer.ts';

describe('runtime lifecycle diagnostics serializer', () => {
  it('selects the complete finite scalar DTO', () => {
    const event = toRuntimeLifecycleEvent({
      schemaVersion: 1,
      event: 'runtime_disposed',
      timestamp: 1_784_126_400_000,
      reason: 'shutdown',
      ownerKey: 'owner:0123456789abcdef',
      workspaceKey: 'workspace:0123456789abcdef',
      sessionKey: 'session:0123456789abcdef',
      runtimeKey: 'runtime:0123456789abcdef',
      turnKey: 'turn:0123456789abcdef',
      childKey: 'child:0123456789abcdef',
      provider: 'pi',
      pid: 1234,
      liveCount: 4,
      retainedCount: 2,
      activeCount: 1,
      queuedCount: 3,
      durationMs: 450,
      runtimeEpoch: 7,
      generation: 8,
      disposalOutcome: 'forced',
      observedExit: true,
      attemptedGraceful: true,
      forced: true,
      errorClass: 'subprocess',
      errorCode: 'runtime_dispose_timed_out',
    });

    expect(event).toEqual({
      schemaVersion: 1,
      event: 'runtime_disposed',
      timestamp: 1_784_126_400_000,
      reason: 'shutdown',
      ownerKey: 'owner:0123456789abcdef',
      workspaceKey: 'workspace:0123456789abcdef',
      sessionKey: 'session:0123456789abcdef',
      runtimeKey: 'runtime:0123456789abcdef',
      turnKey: 'turn:0123456789abcdef',
      childKey: 'child:0123456789abcdef',
      provider: 'pi',
      pid: 1234,
      liveCount: 4,
      retainedCount: 2,
      activeCount: 1,
      queuedCount: 3,
      durationMs: 450,
      runtimeEpoch: 7,
      generation: 8,
      disposalOutcome: 'forced',
      observedExit: true,
      attemptedGraceful: true,
      forced: true,
      errorClass: 'subprocess',
      errorCode: 'runtime_dispose_timed_out',
    });
  });

  it('never traverses or emits malicious nested prompts, tools, credentials, metadata, or errors', () => {
    const rawError = new Error('raw-error-secret');
    rawError.stack = 'raw-stack-secret';

    const serialized = serializeRuntimeLifecycleEvent({
      schemaVersion: 1,
      event: 'lifecycle_error',
      timestamp: 100,
      reason: 'failed',
      provider: 'anthropic',
      errorClass: 'provider',
      errorCode: 'runtime_backend_crashed',
      prompt: 'prompt-secret',
      message: 'message-secret',
      messages: ['message-array-secret'],
      toolPayload: {
        input: 'tool-input-secret',
        result: 'tool-result-secret',
        nested: { prompt: 'nested-prompt-secret' },
      },
      credentials: {
        token: 'credential-token-secret',
        headers: { Authorization: 'bearer-secret' },
      },
      metadata: {
        arbitrary: 'metadata-secret',
        error: rawError,
      },
      error: rawError,
      errorMessage: 'top-level-error-secret',
      stack: 'top-level-stack-secret',
      sessionKey: { toString: () => 'coercion-secret' },
    });

    expect(serialized).not.toBeNull();
    expect(serialized).toBe(JSON.stringify({
      schemaVersion: 1,
      event: 'lifecycle_error',
      timestamp: 100,
      reason: 'failed',
      provider: 'anthropic',
      errorClass: 'provider',
      errorCode: 'runtime_backend_crashed',
    }));

    for (const secret of [
      'prompt-secret',
      'message-secret',
      'message-array-secret',
      'tool-input-secret',
      'tool-result-secret',
      'nested-prompt-secret',
      'credential-token-secret',
      'bearer-secret',
      'metadata-secret',
      'raw-error-secret',
      'raw-stack-secret',
      'top-level-error-secret',
      'top-level-stack-secret',
      'coercion-secret',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('omits invalid enums, unsafe numbers, non-booleans, and unsafe correlation text', () => {
    expect(toRuntimeLifecycleEvent({
      schemaVersion: 1,
      event: 'turn_started',
      timestamp: 10,
      reason: 'arbitrary_reason',
      provider: 'open-ended-provider',
      pid: -1,
      liveCount: Number.POSITIVE_INFINITY,
      durationMs: 1.5,
      runtimeEpoch: Number.MAX_SAFE_INTEGER + 1,
      forced: 'true',
      errorClass: 'raw Error constructor name',
      errorCode: 'secret-provider-error-text',
      ownerKey: 'unsafe key with spaces and\nnewlines',
    })).toEqual({
      schemaVersion: 1,
      event: 'turn_started',
      timestamp: 10,
    });
  });

  it('bounds correlation fields and the complete serialized line', () => {
    const serialized = serializeRuntimeLifecycleEvent({
      schemaVersion: 1,
      event: 'runtime_created',
      timestamp: 10,
      ownerKey: 'a'.repeat(10_000),
      workspaceKey: 'b'.repeat(10_000),
      sessionKey: 'c'.repeat(10_000),
      runtimeKey: 'd'.repeat(10_000),
      turnKey: 'e'.repeat(10_000),
      childKey: 'f'.repeat(10_000),
    });

    expect(serialized).not.toBeNull();
    const parsed = JSON.parse(serialized!) as Record<string, unknown>;
    for (const key of ['ownerKey', 'workspaceKey', 'sessionKey', 'runtimeKey', 'turnKey', 'childKey']) {
      expect((parsed[key] as string).length).toBe(RUNTIME_LIFECYCLE_CORRELATION_MAX_CHARS);
    }
    expect(new TextEncoder().encode(serialized!).byteLength).toBeLessThanOrEqual(
      RUNTIME_LIFECYCLE_EVENT_MAX_BYTES,
    );
  });

  it('rejects unknown schema versions, event names, and invalid timestamps', () => {
    expect(serializeRuntimeLifecycleEvent({ schemaVersion: 2, event: 'runtime_created', timestamp: 1 })).toBeNull();
    expect(serializeRuntimeLifecycleEvent({ schemaVersion: 1, event: 'raw_event', timestamp: 1 })).toBeNull();
    expect(serializeRuntimeLifecycleEvent({ schemaVersion: 1, event: 'runtime_created', timestamp: -1 })).toBeNull();
    expect(serializeRuntimeLifecycleEvent(null)).toBeNull();
  });
});
