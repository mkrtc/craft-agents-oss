# Corrected A0 / A1–A7 / R1 / R2 / R2-3 Readiness Matrix

**Date (authoritative):** Wednesday, July 15, 2026 at 05:25 PM GMT+3
**Working tree:** `work/memory-connections-wave-a-integration`
**Baseline SHA:** `06e8c4db`
**Current integration HEAD:** `237843767396636238fe3c30537d16b3b254eeea`

## Legend

- **PASS** – verified by evidence and no unresolved blocker for this scope.
- **FAIL** – verifiable failure remains.
- **BLOCKED** – not permitted to dispatch due policy or dependency not yet ready.
- **NOT RUN** – not executed in this corrective task.
- **NOT READY** – insufficient policy or evidence to permit implementation.

## Gate summary (required statement)

- **A0** is **NOT READY** and now **ready-for-re-audit only**.
- **A1+** dispatch remains **BLOCKED** until independent re-audit accepts this corrected A0 set.
- **A4a** is a **pure-contract/decision** gate that must complete and be re-audited before A1.
- **Wave A** is not ready for work; **Wave B/C are forbidden**.

## Readiness table

| ID | Area | Required outcome | Current outcome | Status |
|---|---|---|---|---|
| **A0** | Corrective artifact committed + gate semantics | Untracked docs replaced by one authoritative set and explicit BLOCKED gates for A1+ | Docs are now corrected and re-articulated in this task | **NOT READY** (still blocked by unresolved findings) |
| **A4a** | Decision-only contract freeze (saga + limits/identity/byte-cap/version ownership) | A4a owns only `limits.ts`, `types.ts`, `identity.ts`, `validation.ts`, related tests; no product-code implementations in scope | Contract ownership freeze is now explicit; no product-code implementation yet | **BLOCKED** |
| **A1** | Contract limits and strict validators | No false PASS; bounded limits and input constraints validated | Static schema looks strong, but not enough for dispatch | **FAIL** |
| **A2** | Bounded no-follow reads + repository FS containment | Deterministic validation + symlink/e2e boundary guarantees before mutation | FS containment tests reveal unresolved failure paths | **FAIL** |
| **A3** | Authz + scope + handler boundaries | Session/workspace/project membership controls for all credentialed reads/writes | Policy is defined, but enforcement and probe evidence still missing | **BLOCKED** |
| **A4** | Repository persistence + recovery | Durability and recovery semantics proven under failure modes | Cross-process/corrupt-path failures remain | **FAIL** |
| **A5** | Secret-free config/credential separation | No secret leaks in DTO/config/log/snapshot shape | Partial implementation exists, but saga protocol not enforced | **NOT READY** |
| **A6** | Resolver and reconciler safety | Deterministic denied/accepted outcome with non-leak output | **Policy documented in ADR; product enforcement missing** | **BLOCKED** |
| **A7** | Tool/probe readiness under safe transport | Toolchain only after transport + resolver hardening | **Transport policy documented in ADR; runtime hardening still missing** | **BLOCKED** |
| **R1** | Credential/config/saga/fault safety findings | No false readiness; all blockers stated with fail-closed policy | Several P0/P1 findings still unresolved | **FAIL** |
| **R2** | No silent corruption + explicit status outcomes | Every error path explicit and persisted with fail semantics | Multiple storage/race findings unresolved | **FAIL** |
| **R2-3** | Malformed payload quarantine & repo resilience | Quarantine and explicit fail-fast semantics | Partial pass; hardening required to move from advisory to mandatory | **BLOCKED** |

## Exact verification command ledger (copy-pasteable)

### Required command families and intended outcomes

```bash
/home/mkrtc/.bun/bin/bun test packages/shared/src/project-memory/connections/__tests__/repository.test.ts packages/shared/src/project-memory/connections/__tests__/validation.test.ts packages/shared/src/project-memory/connections/__tests__/environment.test.ts packages/shared/src/project-memory/connections/__tests__/session-refs.test.ts packages/shared/src/project-memory/connections/__tests__/dto.test.ts packages/shared/src/project-memory/connections/__tests__/boundary.test.ts
/home/mkrtc/.bun/bin/bun test packages/shared/src/credentials/__tests__/memory-credentials.test.ts
/home/mkrtc/.bun/bin/bun test packages/server/src/__tests__/smoke.test.ts
/home/mkrtc/.bun/bin/bun test packages/session-tools-core/src/**/*.test.ts
/home/mkrtc/.bun/bin/bun test packages/server-core/src/**/*.test.ts
/home/mkrtc/.bun/bin/bun run typecheck:all
/home/mkrtc/.bun/bin/bun run validate:ci
/home/mkrtc/.bun/bin/bun run lint
```

### Command outcomes (known)

- `/home/mkrtc/.bun/bin/bun test ...` targeted files above: **95 tests** | **92 pass** | **3 fail** | **0 error** (this is exact known current outcome)
- `/home/mkrtc/.bun/bin/bun test packages/shared/src/credentials/__tests__/memory-credentials.test.ts`: **NOT RUN in this task**
- `/home/mkrtc/.bun/bin/bun test packages/server/src/__tests__/smoke.test.ts`: **NOT RUN in this task**
- `/home/mkrtc/.bun/bin/bun test packages/session-tools-core/src/**/*.test.ts`: **NOT RUN in this task**
- `/home/mkrtc/.bun/bin/bun test packages/server-core/src/**/*.test.ts`: **NOT RUN in this task**
- `/home/mkrtc/.bun/bin/bun run typecheck:all`: **NOT RUN in this task**
- `/home/mkrtc/.bun/bin/bun run validate:ci`: **NOT RUN in this task**
- `/home/mkrtc/.bun/bin/bun run lint`: **NOT RUN in this task**
- **Prior provided audit aggregate:** **98 pass / 8 fail / 4 error** across **106 tests**, with additional setup/load failures; command is **`historical auditor run, exact command unavailable; not acceptable as future gate`**.

### Credential/backend/session-tools/server-core scanner

- There is no dedicated project scanner script/command currently defined in this repo.
- Concrete manual fallback for reproducible secret/keyword scanning (when scanner is unavailable):

```bash
cd /home/mkrtc/Desktop/projects/worktrees/craft-agents-oss-memory-connections && \
git grep -RIn -E --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build \
  "AKIA[0-9A-Z]{16}|[Aa][Pp][Ii][_\-]?[Kk][Ee][Yy]|[Bb][Ee][Aa][Rr][Ee][Rr][[:space:]][A-Za-z0-9._-]+|[Ss][Ee][Cc][Rr][Ee][Tt]|[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]" .

This fallback does not replace a scanner gate; it is a temporary manual audit mechanism only.

## Cross-platform verification requirement (mandatory)

Wave A matrix must include explicit Linux/macOS/Windows outcomes for FS/race cases or declare fail-closed supported behavior.

- **Current status:** **NOT RUN on all OS variants yet** in this doc correction pass; therefore this requirement remains a gate.

## Status notes for each area

- **A1/A2/A3/A6/A7 currently should not remain marked PASS.**
- Any downstream executor prompt must use only PASS entries from this matrix and treat `A1` onward as non-dispatchable until status moves to PASS.
- Repo-relative links are now preferred and used throughout this artifact set.
