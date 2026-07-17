/**
 * reducer.ts — production-faithful application of CRFT-STREAM-V1 trace events.
 *
 * Each function returns a NEW messages array (shallow copy) with only the target
 * message replaced/inserted, exactly mirroring the renderer's delta handlers:
 * "shallow-copy `session.messages`, preserving non-target `Message` references
 * but replacing the array and target message". The oracle and the live harness
 * both drive their state through this reducer so their results are identical.
 */
import type { Message } from '@craft-agent/core'
import type { TraceEvent } from './types'

/** Replace the message with id `id` using `patch`, preserving other references. */
function replaceById(messages: Message[], id: string, patch: (m: Message) => Message): Message[] {
  const next = messages.slice()
  const i = next.findIndex((m) => m.id === id)
  if (i !== -1) next[i] = patch(next[i]!)
  return next
}

/** Apply one trace event, returning a fresh messages array. */
export function applyTraceEvent(messages: Message[], event: TraceEvent): Message[] {
  switch (event.kind) {
    case 'stream_start': {
      const next = messages.slice()
      if (event.userMessageId) {
        next.push({
          id: event.userMessageId,
          role: 'user',
          content: event.userContent ?? '',
          timestamp: event.userTimestamp ?? event.timestamp,
        })
      }
      next.push({
        id: event.messageId,
        role: 'assistant',
        content: '',
        timestamp: event.timestamp,
        turnId: event.turnId,
        isStreaming: true,
        isPending: true,
      })
      return next
    }

    case 'text_delta':
      return replaceById(messages, event.messageId, (m) => ({ ...m, content: m.content + event.chunk }))

    case 'text_complete':
      return replaceById(messages, event.tempMessageId, (m) => ({
        ...m,
        id: event.messageId,
        timestamp: event.timestamp,
        content: event.content,
        isStreaming: false,
        isPending: false,
        isIntermediate: event.isIntermediate,
      }))

    case 'user_boundary': {
      const next = messages.slice()
      next.push({ id: event.messageId, role: 'user', content: event.content, timestamp: event.timestamp })
      return next
    }

    case 'tool_late_complete':
      return replaceById(messages, event.messageId, (m) => ({
        ...m,
        toolResult: event.toolResult,
        toolStatus: 'completed',
      }))

    case 'annotation_update':
      return replaceById(messages, event.messageId, (m) => ({ ...m, annotations: event.annotations }))

    case 'compaction_complete': {
      const next = messages.slice()
      next.push({
        id: event.messageId,
        role: 'info',
        content: event.content,
        timestamp: event.timestamp,
        statusType: 'compaction_complete',
      })
      return next
    }

    case 'interruption': {
      const next = messages.slice()
      next.push({
        id: event.messageId,
        role: 'info',
        content: event.content,
        timestamp: event.timestamp,
        infoLevel: 'info',
      })
      return next
    }

    case 'hidden_insert': {
      const next = messages.slice()
      next.push(event.message)
      return next
    }

    case 'hidden_remove':
      return messages.filter((m) => m.id !== event.messageId)

    case 'full_session_replacement':
      // Reconnect/replay replaces the entire transcript with fresh references.
      return event.messages.map((m) => ({ ...m }))
  }
}
