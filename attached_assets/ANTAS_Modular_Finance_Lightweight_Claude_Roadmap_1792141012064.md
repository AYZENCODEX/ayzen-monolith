# ANTAS Modular Finance --- Lightweight Claude Prompt & Roadmap

## Copy/paste prompt for Claude

You are working on the existing ANTAS codebase. Safely modularize
Finance through small, verifiable extractions. Preserve behavior and
public contracts. Do not rewrite unrelated files.

### Non-negotiable rules

1.  Inspect the actual repository before editing; discover Finance
    files, routes, callers, DB models/migrations, jobs, events, provider
    adapters, tests, scripts and CI rules. Never assume paths.
2.  Preserve current business behavior, money precision, rounding, fees,
    authorization, transaction semantics, API/event/webhook contracts
    and provider behavior.
3.  Do not reformat or rewrite unrelated files. Do not discard user
    changes, reset history, or delete legacy files until consumers are
    migrated and proof exists.
4.  Extract existing logic and rewire callers; do not create a second
    implementation and call it modularization.
5.  Do not create modules for features that do not exist. Document
    absent features instead.
6.  Evidence beats claims. Run commands and record real exit codes. A
    successful build cannot override failing tests or financial
    invariants.
7.  Missing checks, unknown ownership, stale evidence, skipped tests or
    failures mean BLOCKED/FAIL, never PASS.
8.  Record commit SHA and working-tree state before changes. Never claim
    Git provenance if unavailable.
9.  Execute one sub-phase at a time; inspect the diff before continuing.
10. If baseline tests fail, preserve their output and do not weaken
    tests to get green.

### Candidate boundaries (guidance only)

-   `domain`: money/currency rules and core types
-   `application`: use cases and orchestration
-   `ledger`: journal/posting, if present
-   `accounts`: account lifecycle and balance ownership
-   `transactions`: transaction states and transfers
-   `payments`: deposits/withdrawals/provider flows, if present
-   `fees`: fees/commissions, if present
-   `reconciliation`: settlement and mismatch detection, if present
-   `infrastructure`: repositories, providers, persistence, messaging
-   `contracts`: public schemas/types

Use only boundaries justified by the real code. Keep routes as
compatibility adapters where possible. Do not introduce microservices or
redesign the database as part of this refactor.

### Required report after every sub-phase

Report objective, inspected files, changed/created/deleted files,
old-to-new mapping, migrated and remaining consumers, commands and exit
codes, tests/invariants, diff review, evidence path, status (`PASS`,
`BLOCKED`, `FAIL`), and next safe step.

### Evidence

Write machine-readable evidence under the existing ANTAS reports
convention; if none exists, use `reports/antas/finance/`. Include
phase/sub-phase, timestamp, commit SHA or explicit `UNAVAILABLE`,
working-tree state, commands and exit codes, files changed, old-to-new
mapping, tests run, failures/limitations, and status derived from actual
results. Never store secrets. Do not claim unsigned evidence is signed.

### Validator rules

Reuse existing validators and scripts. Any new validator must inspect
the actual tree and exit non-zero if required source/evidence is
missing, mapped symbols are absent, forbidden imports/cycles or
duplicate implementations exist, required checks fail or were skipped,
evidence is stale, or a bypass/force-pass option is used. Avoid building
a giant framework.

### Start now: FIN-00-A ONLY

1.  Inspect repository root, package manager, scripts, ANTAS conventions
    and working-tree status.
2.  Find Finance source roots and direct/indirect consumers.
3.  Inventory routes/APIs, models/tables/migrations, workers/events,
    providers, tests and config.
4.  Generate a source inventory and
    `source → target owner → consumers → status` migration map from the
    repository.
5.  Identify baseline build/test/typecheck commands from package scripts
    and CI. Run safe baseline checks and capture outputs/exit codes.
6.  Do not fix unrelated failures.
7.  Propose the smallest first extraction, but do not implement it until
    FIN-00-A passes or I explicitly authorize it.
8.  Stop and report. Do not execute later phases yet.

## Lightweight roadmap

### FIN-00 --- Inventory and baseline

-   Discover Finance sources, business symbols, consumers, migrations,
    jobs, events and providers.
-   Capture commit/worktree state and baseline build/tests.
-   Deliver: `finance-inventory.md`, `finance-migration-map.json`,
    `FIN-00-A-evidence.json`.
-   **Gate:** every discovered source is mapped or explicitly excluded;
    baseline failures captured; no business logic changed.

### FIN-01 --- Module boundaries

-   Choose boundaries from actual responsibilities.
-   Assign one canonical owner per operation.
-   Define allowed imports and forbidden dependencies; retain route
    adapters.
-   Deliver: `finance-boundaries.md` and dependency scan.
-   **Gate:** no duplicate owner, unexplained cycle or public contract
    change.

### FIN-02 --- First extraction

-   Pick one cohesive, low-risk slice after inventory (prefer a small
    domain utility/read-only responsibility before money-moving
    orchestration).
-   Capture baseline tests, move existing implementation, rewire
    callers, keep compatibility adapters as needed.
-   **Gate:** real implementation moved, consumers use canonical owner,
    no duplicate logic, behavior matches baseline.

### FIN-03 --- Money-critical paths

-   Map amount precision, currency, rounding, transaction scope and
    existing ledger/balance design.
-   Test rollback, duplicate requests, retries, concurrency and
    applicable accounting invariants.
-   Do not assume double-entry if the documented system uses another
    model.
-   **Gate:** no unexplained balance delta, precision drift, duplicate
    movement, partial commit or authorization widening.

### FIN-04 --- Integrations and consumer migration

-   Extract provider/payment/fee/reconciliation code only where present.
-   Migrate callers in small groups; preserve API, event, webhook and
    provider contracts.
-   Test retries, timeouts, signatures and duplicate callbacks where
    applicable.
-   **Gate:** no duplicate implementation, unverified consumer or
    contract regression.

### FIN-05 --- Legacy retirement

-   Scan imports, dynamic imports, routes, workers and tests for old
    consumers.
-   Remove old implementations only after usage and rollback are
    understood.
-   Add lightweight CI checks for boundaries, cycles and duplicate
    ownership.
-   **Gate:** no unexplained legacy consumer or second source of truth.

### FIN-06 --- Final verification

-   Run required unit/integration/contract/security tests, typecheck,
    lint and build.
-   Verify migration/rollback safety if a schema change was separately
    approved.
-   Run staging smoke tests if available; inspect the full diff for
    unrelated changes.
-   Deliver `finance-final-validation.json`, logs and final migration
    map.
-   **Gate:** required checks pass and evidence matches current source
    revision. Mark unrun staging/production checks `NOT VERIFIED`.

## Financial invariants to test where applicable

-   Amount precision, currency and rounding unchanged.
-   Failed operations cannot leave partial money movement.
-   Retries do not create duplicate transactions or payouts.
-   Concurrent operations cannot cause lost updates or unexplained
    balance drift.
-   Unauthorized/cross-account operations are denied.
-   Fees/commissions match baseline fixtures.
-   Provider callbacks are verified and deduplicated.
-   Reconciliation detects missing, duplicate and mismatched records.
-   Audit retains actor, timestamp and correlation information.
-   Only claim an invariant passed if its test actually ran.

## Compact tracker

  Phase    Deliverable              Hard gate
  -------- ------------------------ ---------------------------------------------
  FIN-00   Inventory + baseline     Sources mapped; failures captured
  FIN-01   Boundaries               Single owner; no unexplained cycles
  FIN-02   First extraction         Behavior preserved; no duplicate logic
  FIN-03   Financial verification   Applicable invariants pass
  FIN-04   Consumer migration       Contracts and retries preserved
  FIN-05   Legacy retirement        No unexplained old consumers
  FIN-06   Evidence pack            Required checks pass; limitations disclosed

## Definition of done

A phase is complete only when the implementation exists in the real
source tree, required checks ran and passed, applicable financial
invariants pass, no duplicate owner or unexplained legacy consumer
remains, the diff has no unrelated edits, and evidence reflects the
current source revision.

**Never:** rewrite → claim PASS → deploy.\
**Always:** inspect → baseline → extract → rewire → test → validate →
review diff → record evidence.

**First action:** execute FIN-00-A in audit-first/read-only mode. Return
inventory, baseline findings, migration map, exact commands/results and
the proposed first extraction. Do not edit business logic yet.
