# ADR A0 — Wave A Project Memory Discovery Corrective Gate

**Date (authoritative):** Wednesday, July 15, 2026 at 05:25 PM GMT+3
**Working tree:** `work/memory-connections-wave-a-integration`
**Baseline SHA:** `06e8c4db` (baseline checkpoint)
**Branch HEAD:** `237843767396636238fe3c30537d16b3b254eeea`
**Scope:** docs-only correction for Wave A readiness gate and dispatcher policy

This ADR replaces the previous uncommitted drafts in this worktree and sets explicit gates for Wave A implementation. It is intentionally strict: if any blocking finding remains, **A1+ is not allowed to dispatch**.

## A. Status / Gate Summary

- **A0 status:** **needs-correction-now** (this document is the corrected gate artifact).
- **Re-audit outcome expected:** A0 can proceed only as **ready-for-re-audit** after independent external review accepts this doc set.
- **Dispatch policy:** **A1+ implementation is BLOCKED until this A0 correction commit is reviewed and accepted.**
- **Wave progression:** Wave A not ready for execution; **Wave B/C are forbidden** until Wave A gates pass.

## B. Finding-by-finding disposition for accepted P0/P1 themes

| Theme | Required disposition | Current state after correction | Evidence file(s)
|---|---|---|---|
| Credential fault-test isolation / real `~/.craft-agent` credential safety | **BLOCKED** until injectable roots and guardrails are part of test contract | ❌ Missing explicit test isolation contract and no documented fixture-root discipline for destructive credential tests | [session-tools-core handlers](packages/session-tools-core/src/handlers/project-memory.ts), [credential manager](packages/shared/src/credentials/manager.ts), [credentials tests](packages/shared/src/credentials/__tests__/memory-credentials.test.ts) |
| Credential backend durability + manager contract | **FAIL** on concurrent and recovery behaviors under current code | ❌ Storage tests show remaining durability/recovery failures in repository behavior under boundary conditions | [repository tests](packages/shared/src/project-memory/connections/__tests__/repository.test.ts), [environment tests](packages/shared/src/project-memory/connections/__tests__/environment.test.ts) |
| Credential/config saga protocol | **BLOCKED** | ✅ Policy is documented; product enforcement remains missing in code/tests | [credentials types](packages/shared/src/credentials/types.ts), [dto](packages/shared/src/project-memory/connections/dto.ts), [repository](packages/shared/src/project-memory/connections/repository.ts) |
| Repository FS containment / bounded I/O | **FAIL** | ❌ Symlink containment checks and path-bound guarantees incomplete in enforced mode | [repository tests](packages/shared/src/project-memory/connections/__tests__/repository.test.ts) |
| Repository cross-process locking / fenced reread / transaction recovery | **FAIL** | ❌ Two-process same-revision acknowledgement test currently fails | [repository tests](packages/shared/src/project-memory/connections/__tests__/repository.test.ts) |
| Migration/version / v1→v2 discriminators | **BLOCKING OPEN QUESTION** | ✅ Saga/version/identity policy freeze is documented in this ADR, but discriminator values, fail behavior, and rollback ownership are not yet enforced in code | [validation tests](packages/shared/src/project-memory/connections/__tests__/validation.test.ts), [validation contract](packages/shared/src/project-memory/connections/validation.ts) |
| Centralized default-deny resolver + authorizer | **BLOCKED** | ✅ Resolver contract is documented in this ADR; centralized deny-first runtime/test enforcement is not yet implemented | [session refs](packages/shared/src/project-memory/connections/session-refs.ts), [SessionManager](packages/server-core/src/sessions/SessionManager.ts), [projects handler](packages/session-tools-core/src/handlers/project-memory.ts) |
| Qdrant transport SSRF / redirect / DNS / egress policy | **BLOCKED** | ✅ Qdrant transport policy checklist is documented; runtime safeguards, tests, and strict failure behavior are still missing | [qdrant transport](packages/shared/src/project-memory/qdrant.ts), [qdrant tests](packages/shared/src/project-memory/qdrant.test.ts) |
| Identity, limits, bytes, numeric safety, global collision | **BLOCKING OPEN QUESTION** | ✅ Decision points (canonical identity tuple, serialized bytes, and overflow policy) are documented; enforcement details and ownership are not yet fully closed | [identity](packages/shared/src/project-memory/connections/identity.ts), [limits](packages/shared/src/project-memory/connections/limits.ts), [validation](packages/shared/src/project-memory/connections/validation.ts) |
| Worktree topology | **NOT READY** | ❌ No canonical worker topology contract exists outside this ADR | [repo docs](docs/A0-memory-connections-discovery-adr.md) |
| Verification matrix + cross-platform FS coverage | **NOT COMPLETE** | ❌ Matrix now has concrete commands and outcomes, but Linux/macOS/Windows outcomes are still needed for FS/race evidence | [this ADR + matrix docs](docs/A0-readiness-matrix.md) |

## C. Default-Deny Resolver (explicit contract)

The resolver must be treated as a **runtime admission control** and is denied by default for every decision.

### Resolver input and trust boundaries

1. **Trusted lookup input:** resolve against the server session workspace/project identity only from trusted server state (no client-provided workspace IDs).
2. **Connection/state fetch prechecks** (all required, fail-closed):
   - server/session must be resolvable and enabled
   - workspace/project/source must be active, not deleted, and not disabled
   - connection must be present and not deleted
   - requested space ids must be present and not deleted
3. **Membership checks (read/write split):**
   - Read membership checks for each candidate selection.
   - Write checks additionally require writable flag and write-mode membership.
   - Membership failure **does not** trigger callback, network, or credential access.
4. **Global scope rule:**
   - Global scope is read-open by design for project-memory access.
   - **Global is never writable** in resolver output.
   - If global policy is unresolved, treat as **BLOCKING OPEN QUESTION** and deny write attempts.
5. **Binding policy (workspace/project/custom):**
   - workspace binding requires workspace existence and membership; project binding requires parent workspace match; custom binding requires explicit owner/custom-space contract (no implicit global fallback).
6. **Refs semantics:**
   - enforce max refs, dedupe with canonical ordering, and explicit `mode` semantics (`read`, `write`).
   - explicit mode never downgraded implicitly.
7. **No secret output:** resolver output must be identity-only (ids, mode, writable/readable flags, reasons), never secrets, credentials, or bearer payloads.
8. **No fallback:** do not map managed refs from stored legacy raw Qdrant store when managed refs are unavailable or invalid.

### Output format rule

`[sessionId, selection, denyReasonCodes, decisionTrace]` where each deny reason is machine-readable and no credential-bearing fields exist.

## D. Credential safety and saga policy (Wave A baseline)

### Non-negotiable guardrails

- **Fault tests must never touch default production path** (`~/.craft-agent`) without explicit injected overrides.
- Destructive tests must accept injectable hooks for:
  - credential root
  - config root
  - file-system primitives
  - clock/timing
- **Secret-bearing staging is forbidden outside encrypted credential store**, even in test fixtures.
- Any failure in corruption, permission, lock, or integrity checks for privileged flows is **fail-closed**.
- **No callback, network, or credential lookup** is executed when resolver denies access.

### Frozen saga operation names

Wave A uses one canonical set of operations everywhere:

- `createConnection`
- `updateConnectionConfig`
- `deleteConnection`
- `setApiKey`
- `replaceApiKey`
- `clearApiKey`
- `setCredentialMode`
- `migrateLegacyUppercaseCredentials`
- `startupRecovery`

### Frozen saga marker vocabulary

Wave A uses one marker/step vocabulary for every saga operation:

`prepare` → `stageSecret` → `commitConfig` → `commitCredential` → `reconcile` → `complete` → `rollback`

### Saga and recovery policy

Wave A shall use a **single durable, secret-free saga journal**:

- Journal entries include: `operationId`, `intent`, `targetKind`, `targetId`, `preconditions`, `idempotencyKey`, `actor`, `attempt`, `status`.
- Journal is written before each state mutation and replayed during recovery to ensure idempotent replay.
- Recovery must run to completion before allowing next outer-memory mutation.
- For every mutation operation (`createConnection`, `updateConnectionConfig`, `deleteConnection`, `setApiKey`, `replaceApiKey`, `clearApiKey`, `setCredentialMode`, `migrateLegacyUppercaseCredentials`):
  - `prepare` → `stageSecret` → `commitConfig` → `commitCredential` → `reconcile` → `complete`.
  - On retry/failure use `rollback` before next attempt.
- For `startupRecovery`, run `prepare` → `reconcile` → `complete` and emit `rollback` if the process cannot complete.

## E. Migration / version policy (required for A3+)

1. **Target version:** intended target is `v2` for durable compatibility; until the migration discriminators are finalised this remains a **blocking open question**.
2. **Discriminators required at load time** (must be explicit and mutually exclusive):
   - **foundation-v1**
   - **pre-repair-v1**
   - **current-v1**
3. **Migration detector:** pre-validation detector with idempotent detection before any write.
4. **Failure policy:** ambiguous/corrupt/future versions must fail closed and never silently down-convert.
5. **Backup/rollback:** every migration attempt records source version, detector version, transform hash, and rollback artifact id.
6. **Credential-affecting migrations:** must execute only through A5 saga and after A3 contract/manager readiness.

## F. Worktree topology and execution model

- **Baseline checkpoint:** `06e8c4db`.
- **Current integration tip:** `237843767396636238fe3c30537d16b3b254eeea`.
- **Current integration branch:** `work/memory-connections-wave-a-integration`.
- **Future workers:** branch from current audited integration tip only; no non-overlapping edits must target overlapping files.
- **Integration model:** serial cherry-pick/review into integration branch.
- **Worker contract:** every worker prompt must record:
  - base SHA
  - expected file set
  - verification commands/results
  - lock-step file ownership

## G. A4a decision-only precondition

### Purpose and scope

- **A4a is decision-only/pure-contracts.** It is a docs-and-contract freeze gate, not product-code implementation.
- **Dispatch rule:** `A4a` may only be dispatched from the independently accepted A0 integration tip and must be re-audited before A1 starts.
- **Current status:** **BLOCKED** pending independent re-audit; this ADR is the first explicit ownership freeze.

### Owned files

- `packages/shared/src/project-memory/connections/limits.ts`
- `packages/shared/src/project-memory/connections/types.ts`
- `packages/shared/src/project-memory/connections/identity.ts`
- `packages/shared/src/project-memory/connections/validation.ts`
- Related tests: `packages/shared/src/project-memory/connections/__tests__/validation.test.ts`, `packages/shared/src/project-memory/connections/__tests__/boundary.test.ts`

### Prohibited overlaps for A4a

- `packages/shared/src/project-memory/connections/repository.ts`
- `packages/shared/src/project-memory/connections/dto.ts`
- `packages/shared/src/project-memory/connections/contracts.ts`
- `packages/shared/src/project-memory/connections/mappers.ts`
- Any `packages/shared/src/project-memory/migrations/**` or migration helper files
- `packages/shared/src/credentials/**`

## H. A-task ordering and file ownership (Wave A)

1. **A0 corrected docs** → independent re-audit required.
2. **A4a pure-contract gate** (decision-only) → independent re-audit required before A1.
3. **A1:** path containment + bounded no-follow reads only.
4. **A2:** mutation durability + cross-process locking + temp/backup/write/recovery.
5. **A3:** credentials backend + credential manager + interface, not `SecureStorageBackend` only.
6. **A5:** saga implementation only after A2, A3, A4a.
7. **A6:** resolver/authorizer after A4a/A5, or pure non-runtime contract only.
8. **A7:** ADR/probes plus transport guards only after safe transport constraints are encoded.
9. **A8:** closure audit/integration finalization.

### Explicitly disallowed overlaps

- `packages/shared/src/project-memory/connections/repository.ts` ownership must be single-worker only.
- `packages/shared/src/project-memory/connections/validation.ts` and `contracts.ts` are reserved to A4a contract owner.
- `packages/shared/src/credentials/*` must remain owned by A3/A5 chain only.

## I. Qdrant egress and transport policy (Wave A dormant-runtime gate)

All production outbound behavior is blocked until all decisions below are resolved.

- HTTPS/loopback/private support policy
- local admin bypass/opt-in policy
- redirect handling (`redirect -> error`)
- DNS rebinding checks
- IPv4/IPv6/IDNA handling and trailing-dot canonicalization
- explicit proxy allow/deny policy
- URL credential rejection (no embedded credentials)
- encoded path hardening
- request timeout + cancellation budget + response size caps
- no secret forwarding across layers

Wave A implementation may only use static non-production negative probes until resolver + safe transport policy is complete and accepted.

## I. Identity, limits, bytes, and numeric safety

### Mandatory choices before A1+ dispatch

- duplicate physical identity policy: **FORBID** aliasing unless explicit dedupe key migration approved by orchestrator/user
- canonical identity tuple: normalized origin + collection + embedding dimension
- canonical path rejection for normalized-away raw paths
- trailing-dot host and IDNA canonicalization defined before hashing
- delimiter-safe, length-prefixed tuple serialization
- global collision checks enforced at validation boundaries
- UTF-8 serialized-byte invariant and max size policy
- safe integer and timestamp overflow handling: fail closed on overflow

### Decision ownership register

- **Byte cap/version/identity/global-collision policy:** owner `A4a`.
- **Qdrant transport policy:** owner `A7`.
- **Any business-policy exception (e.g., duplicate-identity fallback):** owner `orchestrator/user decision`.

## J. Verification matrix policy

A0 acceptance now requires a complete matrix in the companion file with command families and exact outcomes: [A0 readiness matrix](docs/A0-readiness-matrix.md).

## K. Mandatory vs adjacent risks

### Wave A mandatory blockers (cannot dispatch)
- repository durability + symlink/containment
- cross-process mutation serialization and two-process recovery
- fault-test isolation + credential-safety harness
- resolver default-deny + binding policy
- saga-first mutation protocol
- migration/version discriminators
- qdrant transport/egress hardening

### Adjacent repo-wide risks (deferred only with explicit owner + gate)
- broader session-tool test matrix coverage beyond project-memory domains
- cross-platform permission and symlink behavior in non-memory code paths
- linting/secret-scan baseline convergence for unrelated tooling

Each deferred item requires a follow-up task with a dedicated gate before touching adjacent production code paths.

### Closing statement

This ADR establishes a **blocking gate**: until these sections are resolved and independently accepted, A1+ implementation must remain blocked and **Wave B/C remain forbidden**.
