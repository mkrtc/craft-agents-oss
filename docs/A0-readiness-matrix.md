# Corrected A0 / A1–A7 / R1 / R2 / R2-3 Readiness Matrix

**Date (authoritative):** Wednesday, July 15, 2026 at 05:19 PM GMT+3
**Working tree:** `work/memory-connections-wave-a-integration`
**Baseline SHA:** `06e8c4db`

## Legend

- **PASS** – verified by evidence and no unresolved blocker for this scope.
- **FAIL** – verifiable failure remains.
- **BLOCKED** – not permitted to dispatch due policy or dependency not yet ready.
- **NOT RUN** – not executed in this corrective task.
- **NOT READY** – insufficient policy or evidence to permit implementation.

## Gate summary (required statement)

- **A0** is **NOT READY** and now **ready-for-re-audit only**.
- **A1+** dispatch remains **BLOCKED** until independent re-audit accepts this corrected A0 set.
- **Wave A** is not ready for work; **Wave B/C are forbidden**.

## Readiness table

| ID | Area | Required outcome | Current outcome | Status |
|---|---|---|---|---|
| **A0** | Corrective artifact committed + gate semantics | Untracked docs replaced by one authoritative set and explicit BLOCKED gates for A1+ | Docs are now corrected and committed in this task | **NOT READY** (blocked by failing Wave A findings) |
| **A1** | Contract limits and strict validators | No false PASS; bounded limits and input constraints validated | Static schema looks strong, but not enough for dispatch | **FAIL** |
| **A2** | Bounded no-follow reads + repository FS containment | Deterministic validation + symlink/e2e boundary guarantees before mutation | FS containment tests reveal unresolved failure paths | **FAIL** |
| **A3** | Authz + scope + handler boundaries | Session/workspace/project membership controls for all credentialed reads/writes | Resolver policy incomplete for centralized deny-first enforcement | **BLOCKED** |
| **A4** | Repository persistence + recovery | Durability and recovery semantics proven under failure modes | Cross-process/corrupt-path failures remain | **FAIL** |
| **A5** | Secret-free config/credential separation | No secret leaks in DTO/config/log/snapshot shape | Partial implementation exists, but saga protocol absent | **NOT READY** |
| **A6** | Resolver and reconciler safety | Deterministic denied/accepted outcome with non-leak output | Contract not fully explicit; default-deny policy missing | **BLOCKED** |
| **A7** | Tool/probe readiness under safe transport | Toolchain only after transport + resolver hardening | Transport + safe-egress not finalized | **BLOCKED** |
| **R1** | Credential/config/saga/fault safety findings | No false readiness; all blockers stated with fail-closed policy | Several P0/P1 findings still unresolved | **FAIL** |
| **R2** | No silent corruption + explicit status outcomes | Every error path explicit and persisted with fail semantics | Multiple storage/race findings unresolved | **FAIL** |
| **R2-3** | Malformed payload quarantine & repo resilience | Quarantine and explicit fail-fast semantics | Partial pass; hardening required to move from advisory to mandatory | **BLOCKED** |

## Exact verification matrix requirement (per this task)

### Required commands

```bash
/home/mkrtc/.bun/bin/bun test packages/shared/src/project-memory/connections/__tests__/repository.test.ts packages/shared/src/project-memory/connections/__tests__/validation.test.ts packages/shared/src/project-memory/connections/__tests__/environment.test.ts packages/shared/src/project-memory/connections/__tests__/session-refs.test.ts packages/shared/src/project-memory/connections/__tests__/dto.test.ts packages/shared/src/project-memory/connections/__tests__/boundary.test.ts

# plus
# credential/backend/session-tools/server-core session suites
# root validation commands below
bun test
bun run typecheck:all
bun run validate:ci
bun run lint
# secret scan (project-specific scanner command)
```

### Command outcomes we must preserve as outcomes (truthful)

- **Targeted suite above (this run):** `95 tests`, `92 pass`, `3 fail`, `0 error`.
- **Observed failures in this run:**
  - `repository.test.ts`: symlinked memory directory containment
  - `repository.test.ts`: stale-backup mutation when primary is EACCES
  - `repository.test.ts`: two-process same-revision create acknowledgment
- **Independent prior result audit (provided):** `98 pass`, `8 fail`, `4 error` across `106 tests`, with additional failures in suites failing to load due missing dependencies and cross-domain test setup.

### Known failed categories captured (authoritative)

- repo symlink containment
- stale-backup mutation through existing error states
- two-process same-revision acknowledgment
- suite load-time/dependency errors

### Not yet executed in this corrective task

- credential backend full-suite
- session-tools suite
- server-core session suite
- full-root `bun test`
- `bun run typecheck:all`
- `bun run validate:ci`
- `bun run lint`
- secret scan

## Cross-platform verification requirement (mandatory)

Wave A matrix must include explicit Linux/macOS/Windows outcomes for FS/race cases or declare fail-closed supported behavior. This is currently **NOT RUN** and therefore **gated**.

## Status notes for each area

- **A1/A2/A3/A6/A7 currently should **not** remain marked PASS.**
- Any downstream executor prompt must use only PASS entries from this matrix and treat `A1` onward as non-dispatchable until status moves to PASS.
- Repo-relative links are now preferred and used throughout this artifact set.
