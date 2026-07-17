import type { ComponentEntry } from './types'
import { ChatStreamingPerfHarness } from '../perf/ChatStreamingPerfHarness'

/**
 * CRFT-STREAM-V1 renderer performance harness (Lane A). The registry slug
 * `chat-stream-perf` is part of the artifact manifest — open with:
 *   playground.html?component=chat-stream-perf&trace=CRFT-STREAM-V1&autorun=1
 */
export const chatStreamPerfComponents: ComponentEntry[] = [
  {
    id: 'chat-stream-perf',
    name: 'Chat Streaming Perf Harness',
    category: 'Chat',
    description:
      'CRFT-STREAM-V1 deterministic renderer performance harness. Replays 1,200 streaming deltas over a 1,500-message transcript and reports content-free render counts, long tasks, event-to-paint latency, and oracle pass/fail. Configure via URL params (autorun, runs, variant, cadence, warmup, mode, deltaLimit).',
    component: ChatStreamingPerfHarness,
    layout: 'full',
    props: [],
    variants: [{ name: 'Default', props: {} }],
    mockData: () => ({}),
  },
]
