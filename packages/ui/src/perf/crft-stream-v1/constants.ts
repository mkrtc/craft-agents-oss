/**
 * CRFT-STREAM-V1 constants — the frozen definition of the deterministic renderer
 * benchmark fixture and trace. Every value here is part of the artifact contract:
 * R0 freezes it, and R1/R2/T0 must consume the exact same numbers and hashes.
 *
 * See the CRFT Final Orchestrator Plan §"Deterministic renderer benchmark source
 * of truth: CRFT-STREAM-V1".
 */

/** Generator identity, embedded in every manifest/oracle artifact. */
export const GENERATOR_ID = 'CRFT-STREAM-V1'
export const GENERATOR_VERSION = '1.0.0'

/** Playground registry slug used to open the harness; part of the manifest. */
export const HARNESS_SLUG = 'chat-stream-perf'

/** Deterministic seed: hexadecimal 0x43524654 ("CRFT" in ASCII). */
export const SEED = 0x43524654

/**
 * Fixed logical time origin for the fixture. A constant (never Date.now) so the
 * generated timestamps — and therefore all derived hashes — are fully
 * deterministic. 2025-01-01T00:00:00.000Z.
 */
export const TIME_ORIGIN_MS = 1735689600000

/** Milliseconds advanced between adjacent base-fixture messages. */
export const TIME_STEP_MS = 1000

/** Total base messages produced before replay. */
export const TOTAL_MESSAGES = 1500

/** Number of logical turns in the base fixture. */
export const TURN_COUNT = 100

/** Turns that carry a full tool workload (10 tools each). */
export const TOOL_HEAVY_TURN_COUNT = 90

/** Tools per tool-heavy turn. */
export const TOOLS_PER_TOOL_HEAVY_TURN = 10

/** Intermediate assistant messages per turn. */
export const INTERMEDIATE_PER_TURN = 3

/** Number of standalone special messages interleaved through the fixture. */
export const SPECIAL_MESSAGE_COUNT = 100

/** Exact byte sizes for tool result payloads. */
export const TOOL_PAYLOAD_2KIB = 2 * 1024
export const TOOL_PAYLOAD_32KIB = 32 * 1024
export const TOOL_PAYLOAD_192KIB = 192 * 1024

/** Count of tool results at each payload size (sums to 900). */
export const TOOL_PAYLOAD_2KIB_COUNT = 850
export const TOOL_PAYLOAD_32KIB_COUNT = 45
export const TOOL_PAYLOAD_192KIB_COUNT = 5

/** Six deterministic icon-payload identities repeated across tool results. */
export const ICON_IDENTITIES: ReadonlyArray<{ id: string; displayName: string; category: 'skill' | 'source' | 'native' | 'mcp'; iconDataUrl: string }> = [
  { id: 'icon-a', displayName: 'Alpha', category: 'native', iconDataUrl: 'data:image/svg+xml;base64,PHN2Zz5BPC9zdmc+' },
  { id: 'icon-b', displayName: 'Beta', category: 'source', iconDataUrl: 'data:image/svg+xml;base64,PHN2Zz5CPC9zdmc+' },
  { id: 'icon-c', displayName: 'Gamma', category: 'mcp', iconDataUrl: 'data:image/svg+xml;base64,PHN2Zz5DPC9zdmc+' },
  { id: 'icon-d', displayName: 'Delta', category: 'skill', iconDataUrl: 'data:image/svg+xml;base64,PHN2Zz5EPC9zdmc+' },
  { id: 'icon-e', displayName: 'Epsilon', category: 'native', iconDataUrl: 'data:image/svg+xml;base64,PHN2Zz5FPC9zdmc+' },
  { id: 'icon-f', displayName: 'Zeta', category: 'source', iconDataUrl: 'data:image/svg+xml;base64,PHN2Zz5GPC9zdmc+' },
]

/** Ten deterministic tool names cycled across tool-heavy turns. */
export const TOOL_NAMES: ReadonlyArray<string> = [
  'Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'Task', 'TodoWrite', 'mcp__session__call_llm', 'WebFetch',
]

// ---------------------------------------------------------------------------
// Event trace
// ---------------------------------------------------------------------------

/** Primary trace: number of already-main-batched text_delta events. */
export const PRIMARY_DELTA_COUNT = 1200

/** Bytes appended per text_delta event. */
export const DELTA_BYTES = 32

/** Logical cadence between delta events (ms). Matches main-process 50ms batch. */
export const DELTA_CADENCE_MS = 50

/** Second active turn delta count. */
export const SECONDARY_DELTA_COUNT = 200

/**
 * Fixed UI variant used for the primary performance measurement.
 * (Secondary correctness variants are enumerated in the harness.)
 */
export const PRIMARY_VARIANT = {
  visibleTurns: 20,
  activitiesCollapsed: true,
  compactResponseWindow: true,
  searchActive: false,
  stickyBottom: true,
  userScrollDuringTrace: false,
} as const

/** Measurement protocol timings (ms). */
export const WARMUP_MS = 10_000
export const PRIMARY_TRACE_MS = 60_000
export const BASELINE_RUNS = 5
