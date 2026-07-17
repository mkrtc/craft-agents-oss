# CRFT-STREAM-V1 — Deterministic Renderer Benchmark (R0)

Frozen source-of-truth fixture, trace, oracle and manifest for the chat streaming
performance work. **R0 creates and freezes this; R1/R2/T0 must consume the exact
same artifact and hashes.** See the CRFT Final Orchestrator Plan
§"Deterministic renderer benchmark source of truth: CRFT-STREAM-V1".

## What's here

| File | Purpose |
|---|---|
| `constants.ts` | Frozen definition: `SEED=0x43524654`, counts, byte sizes, cadence, protocol timings. |
| `generator.ts` | Pure, deterministic construction of the 1,500-message base fixture + replay trace. |
| `reducer.ts` | Production-faithful application of each trace event (shallow-copy array, replace/insert target message). |
| `oracle.ts` | Canonical `groupMessagesByTurn` + ordered-message hashing; walks the trace recording barrier hashes. |
| `manifest.ts` | Builds the canonical manifest (counts, byte totals, ordered id/role/timestamp list, `fixtureSha256`). |
| `churn-analysis.ts` | Node-light proof that completed historical turns re-render on every ordinary delta. |
| `expected/expected-hashes.json` | **Committed** frozen expectation contract (counts + SHA-256 + oracle hashes). |
| `scripts/generate-artifacts.ts` | Regenerates the committed contract and the full evidence artifacts. |
| `__tests__/` | `bun test` determinism / distribution / oracle / churn / known-answer SHA-256. |

The Lane-A browser harness lives at
`apps/electron/src/renderer/playground/perf/ChatStreamingPerfHarness.tsx`
with a dedicated production entry
`apps/electron/src/renderer/chat-stream-perf.html`.

## Fixture definition (frozen)

- **Generator id / version**: `CRFT-STREAM-V1` / `1.0.0`
- **Seed**: `0x43524654` (`"CRFT"`); PRNG = mulberry32; time origin fixed (no `Date.now`).
- **1,500 base messages**: 100 user · 100 final assistant · 900 tool (10 tools × 90 turns) · 300 intermediate assistant (3 × 100 turns) · 100 special (status/info/warning/error/plan/auth/hidden + compaction-complete pairs).
- **Tool payloads**: 850 × 2 KiB, 45 × 32 KiB, 5 × 192 KiB; six deterministic icon identities cycled.
- **Last visible turns** cover: plain response, tool-heavy, plan, warning/error, annotation, completed compaction status, hidden adjacency, equal-timestamp ties, parent/child tools; the open streaming tail comes from the trace.
- **Trace**: stream-start (temp message) → 1,200 × 32-byte `text_delta` @ 50 ms cadence → `text_complete` (authoritative id + timestamp crossing a boundary) → second user boundary + 200 deltas → late tool completion, annotation update, compaction completion, interruption, hidden insert/remove, full-session replacement. Barriers recorded after each semantic checkpoint.

## Reproduction commands

### 1. Regenerate the deterministic manifest / oracle / churn artifacts

```bash
# From the worktree root. Writes the committed expected-hashes.json, plus the
# full evidence artifacts to the data directory given as the first argument
# (there is no default — pass the current orchestrator/session data folder).
bun run packages/ui/src/perf/crft-stream-v1/scripts/generate-artifacts.ts \
  /path/to/session/data/renderer-perf
```

### 2. Run the targeted tests (determinism, distribution, oracle, SHA-256, churn)

```bash
bun test packages/ui/src/perf/crft-stream-v1/__tests__/
```

### 3. Lane A — production renderer performance harness

```bash
# Build the production renderer with the dedicated perf harness entry included.
# `bun run electron:build:renderer` (plain, used for packaging/shipping) does
# NOT include chat-stream-perf.html — the perf variant sets CRFT_PERF_BUILD=1
# so the entry is only ever produced for an explicit perf build.
bun run electron:build:renderer:perf

# Serve the built playground/harness.
bunx vite preview --config apps/electron/vite.config.ts --host 127.0.0.1 --port 4173

# Open the dedicated harness entry (registry-free, no StrictMode → authoritative
# production single renders). The browser tab MUST be foreground/visible —
# background tabs throttle requestAnimationFrame and invalidate timing.
#   http://127.0.0.1:4173/chat-stream-perf.html?trace=CRFT-STREAM-V1&autorun=1&runs=5&warmup=10000&cadence=50&mode=paced&variant=primary
#
# Fixed viewport: 1440×900, device scale factor 1.
# Results are exposed at window.__CRFT_STREAM_V1_RESULT__ and auto-downloaded as JSON.
```

The harness is also registered in the shared playground as `chat-stream-perf`
(`playground.html?component=chat-stream-perf&autorun=1`); prefer the dedicated
`chat-stream-perf.html` entry for the production preview lane (see the note in
that entry file about the pre-existing shared-playground boot issue).

URL params: `trace`, `autorun`, `runs`, `variant` (`primary` | `activities-expanded` | `search` | `pagination`), `cadence` (ms), `warmup` (ms), `mode` (`paced` | `fast`), `deltaLimit`.

## Metric artifact schema (Lane A result JSON)

```jsonc
{
  "generatorId": "CRFT-STREAM-V1",
  "generatorVersion": "1.0.0",
  "trace": "CRFT-STREAM-V1",
  "variant": "primary",
  "runs": 5,
  "mode": "paced",
  "cadenceMs": 50,
  "warmupMs": 10000,
  "environment": { "userAgent": "...", "hardwareConcurrency": 0, "viewport": {"width":1440,"height":900,"dpr":1} },
  "runResults": [
    {
      "run": 1,
      "variant": "primary",
      "counters": {
        "completedHistoricalTurnRenders": 0,   // completed TurnCard renders during ordinary deltas
        "activeTurnRenders": 0,                 // active (streaming) TurnCard renders
        "chatDisplayRenders": 0                 // container renders
      },
      "longTasks": { "count": 0, "p95Ms": 0, "maxMs": 0, "aggregateMs": 0 },   // browser long tasks > 100 ms
      "eventToPaintMs": { "p50": 0, "p95": 0, "max": 0, "samples": 0 },        // event dispatch → next paint
      "oracle": { "pass": true, "finalGroupingHash": "…", "finalTranscriptHash": "…", "mismatches": [] },
      "deltasApplied": 1411,
      "wallClockMs": 0
    }
  ],
  "summary": {
    "completedHistoricalTurnRenders": { "median": 0, "p95": 0, "max": 0 },
    "activeTurnRenders": { "median": 0, "p95": 0, "max": 0 },
    "chatDisplayRenders": { "median": 0, "p95": 0, "max": 0 },
    "longTaskP95Ms": { "median": 0, "max": 0 },
    "longTaskMaxMs": { "median": 0, "max": 0 },
    "eventToPaintP95Ms": { "median": 0, "max": 0 },
    "eventToPaintMaxMs": { "median": 0, "max": 0 },
    "oraclePass": true
  }
}
```

### Primary render-reduction formula (for R2/T0)

```
reduction = 1 - candidateCompletedHistoricalTurnRenders / baselineCompletedHistoricalTurnRenders
```

Acceptance (R1/R2/T0): ≥ 90 % reduction and zero ordinary-delta historical renders
after the active turn stabilizes (one expected render is allowed when a formerly
last completed card changes `isLastResponse` at a new user-turn boundary).

## Instrumentation (opt-in, content-free)

`@craft-agent/ui` → `perf/streamPerf.ts` exposes `recordTurnCardRender`,
`recordChatDisplayRender`, `enableStreamPerf`, `getStreamPerfCounters`, etc.
Disabled by default and zero-cost when disabled; only integer tallies are stored
— **no** prompt/tool/path/credential content. Wired into the production
`TurnCard` and `ChatDisplay` (first statement of each component body).
