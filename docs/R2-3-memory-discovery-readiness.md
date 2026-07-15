# R2-3 Appendix — Memory Discovery Readiness and Risk Register

**Date (authoritative):** Wednesday, July 15, 2026 at 05:19 PM GMT+3
**Purpose:** authoritative appendix for A0 correction, containing finding disposition and policy freezes for future executor prompts.

## 1) P0/P1 finding disposition (detailed)

### 1.1 Credential fault-test isolation / real `~/.craft-agent` credential safety

- **Disposition:** **BLOCKED**
- **Requirement:** introduce injectable credential/config/fs/clock hooks for destructive tests; forbid fault tests that touch default production root.
- **Current evidence:** hooks are not contractually required in docs/tests; no explicit “do not run on real path” gate in tool/process docs.
- **Required next:** add explicit test harness constraints in Wave A docs and enforce in test scaffolding.

### 1.2 Credential backend durability + manager contract

- **Disposition:** **FAIL**
- **Current evidence:** durability/recovery tests report boundary failures (repo test output in corrected matrix).
- **Required next:** prove storage error handling is fail-closed and idempotent recovery paths work across interrupted/locked writes.

### 1.3 Credential/config saga protocol

- **Disposition:** **NOT READY**
- **Current evidence:** no durable intent / recovery journal and idempotency contract is documented for config-mutating operations.
- **Required next:** add saga intent, journal checkpointing, and replay-before-next-operation semantics.

### 1.4 Repository FS containment / bounded I/O

- **Disposition:** **FAIL**
- **Current evidence:** symlink containment assertions did not fail as expected and path escape behavior remains a blocker.
- **Required next:** harden path resolution, canonical checks, and bounded I/O windows.

### 1.5 Repository cross-process locking / fenced reread / transaction recovery

- **Disposition:** **FAIL**
- **Current evidence:** two real processes both acknowledged create at same root revision in tests.
- **Required next:** enforce single-writer lock + fenced reread + monotonic root revision recovery.

### 1.6 Migration/version policy (v1→v2)

- **Disposition:** **BLOCKING OPEN QUESTION**
- **Current evidence:** explicit discriminators for `foundation-v1`, `pre-repair-v1`, and `current-v1` are not implemented as gating metadata.
- **Required next:** decide migration constants, idempotent pre-validation detector, rollback/backup policy, and corrupted/future-version fail-closed behavior.

### 1.7 Default-deny resolver / authorizer

- **Disposition:** **NOT READY**
- **Current evidence:** resolver semantics are fragmented and not yet a single audited gate.
- **Required next:** create explicit resolver contract in one place with deny-default and no-callback/no-network/no-secret-on-deny behavior.

### 1.8 Qdrant transport / SSRF / egress policy

- **Disposition:** **BLOCKED**
- **Current evidence:** transport policy is not yet fully enumerated for redirects, DNS, IPv4/IPv6, proxy, URLs with credentials, or timeout/body caps.
- **Required next:** define/implement deny rules before using arbitrary stored URLs at runtime.

### 1.9 Identity, limits, serialized bytes, safe integers, global collision

- **Disposition:** **NOT READY**
- **Current evidence:** identity hardening (duplicate/alias policy, serialized serialization, safe-integer overflow, global collision guarantees) not yet locked as gate requirements.
- **Required next:** codify and verify these constraints as mandatory before A1.

### 1.10 Worktree topology / worker collision policy

- **Disposition:** **NOT READY**
- **Current evidence:** no committed topology contract prior to this correction.
- **Required next:** enforce base SHA + expected file set + serial integration for each worker.

### 1.11 Verification matrix / cross-platform matrix

- **Disposition:** **NOT COMPLETE**
- **Current evidence:** matrix had false PASS claims and incomplete OS-specific evidence.
- **Required next:** maintain a live matrix with command families and Linux/macOS/Windows outcomes.

## 2) Exact operation list required for A5 saga

- `createConnection`
- `updateConnection`
- `deleteConnection`
- `setApiKey`
- `replaceApiKey`
- `clearApiKey`
- `setCredentialMode`
- `legacyUppercaseMigration`

For each operation: `intent -> prepare -> acquire lock -> mutate -> verify -> checkpoint -> emit recovery marker -> release`.

## 3) Default-deny resolver freeze list

- trusted server/session/workspace/project lookup first
- disabled/deleted/missing entities denied
- missing/deleted spaces denied
- read-membership required for read mode
- write-membership + writable required for write mode
- global read-only (never writable)
- workspace/project/custom binding explicit and non-fallback
- refs bounds, dedupe, explicit-mode semantics
- no callbacks/network/credential access on deny
- secret-free output shape
- no fallback from managed refs to raw legacy store

## 4) Verification outcomes snapshot (authoritative)

- `/home/mkrtc/.bun/bin/bun test` targeted files: `92 pass / 3 fail / 0 error`.
- Independent audit outcome (provided): `98 pass / 8 fail / 4 error` across `106 tests`.
- Failures include repository symlink containment, stale-backup mutation on EACCES, and two-process same-revision acknowledgment.
- Some suite loads failed due missing test dependencies in the broader run.

## 5) Mandatory vs adjacent risk register

### Mandatory Wave A blockers (must close before A1 dispatch)

1. FS containment and bounded I/O
2. Cross-process concurrency recovery
3. Fault-test isolation + credential-safety harness
4. Resolver default-deny authorizer and binding policy
5. Saga + recovery journal for all mutation operations
6. Migration discriminators and rollback semantics
7. Qdrant transport hardening

### Adjacent repo risks (not part of core Wave A, defer with explicit gate)

- broader session-tool/server-core regressions outside project-memory
- general linting and secret-scan baseline in unrelated areas
- optional-platform behavior not in direct Wave A scope

Deferred risks must be linked to future tasks with explicit acceptance conditions before unblocking adjacent areas.
