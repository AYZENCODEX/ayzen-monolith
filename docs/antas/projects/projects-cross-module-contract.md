# Projects cross-module contract (PRJ-01)

This answers the two open items the roadmap left for PRJ-01: how Projects may
depend on Vault, and how it may depend on Finance. Both decisions were confirmed
by the project owner on 2026-10-20 (D1: Projects imports from Vault directly, as
pinned below; D2: as recommended). The validator enforces them as written.

## Decision D1 — Vault: formal, pinned, allowed import (CONFIRMED)

**Decision.** Option (a). Projects may import exactly these Vault symbols, from
these modules, and nothing else:

| Contract id | Specifier (from `routes/projects.ts`) | Symbols | Used by |
|---|---|---|---|
| `VAULT-PUBLIC-1` | `../vault/application/kyc/enrollment` | `loadKycEntryForEnrollment`, `buildEnrollmentAccountData` | `POST /projects/:id/enroll` |
| `VAULT-PUBLIC-2` | `../vault/security/kyc-ownership` | `kycEntryOwnerResource` | audit-only `project.enroll.kyc_entry` decision in the same route |

**Why (a) and not a Projects-side shim.** These are already the only Vault
imports in `projects.ts`, and deep imports into `vault/application/*` and
`vault/security/*` are how the rest of the API server consumes Vault today
(`routes/vault*.ts`, `routes/wallets.ts`, `routes/value-history.ts`). A shim would
add a layer without removing the coupling, and `application/enrollment.ts` must
not re-implement KYC logic either way.

**What this does not do.** It does not widen Vault. No Vault file changes. The
committed surface is three functions that already exist and already have this
caller. `loadKycEntryForEnrollment` returns the still-encrypted row;
`buildEnrollmentAccountData` decrypts it with Vault's own `KYC_SENSITIVE_FIELDS`.
Projects must keep calling them as they are and must not copy the field list.

**Obligation on Vault.** A signature or behavior change to these three symbols is
a change to Projects' contract. The validator fails if the Projects import list
or symbol set changes, and fails if the allowlist entry goes stale.

**Reverse coupling, recorded not fixed.** Vault reads Projects tables directly:
`vault/infrastructure/repositories/kyc-repository.ts` reads `project_enrollments`
and `projects` (unused-entry filter, usage listing), and
`snapshot-sections-repository.ts` runs `SELECT *` on six Projects tables for
snapshots. These are table edges, not code imports, so nothing imports Projects
code from Vault (verified: zero). They are listed in `knownExternalConsumers`
with resolving phase PRJ-05. Any Projects column change must keep them valid.

**Not covered by D1.** Projects defines its own `vaultEntryOwnerResource`, which
reads `vault_entries` directly and uses its own `-1` sentinel. Vault has a
similar `vaultEntryResource` in `vault/security/entity-ownership.ts`, but it reads
`req.params.id` only, while Projects reads `req.params.vaultEntryId` or
`req.body.vaultEntryId`. They are not interchangeable, so this is not a duplicate
to delete. It stays behavior-frozen and moves to `security/entity-ownership.ts`
in PRJ-05. Whether Vault should expose an owner-lookup function instead is a
PRJ-05 question; PRJ-01 does not add one.

## Decision D2 — Finance: no swap; a new per-project use case, parity first (CONFIRMED, SUPERSEDED by D2' below)

**Finding.** The roadmap's PRJ-04 step replaces the ledger read in
`computeProjectPnlSummary()` with "Finance's existing P&L use case". That use
case does not exist in the required shape.

| | `computeProjectPnlSummary(userId, projectId)` in `routes/projects.ts` | `getProjectInvestments(userId)` in `finance/application/reports.ts` |
|---|---|---|
| Scope | one project | every project the user tagged |
| Currency | sums `amount` as stored, no conversion | groups by currency, converts with `getRateMap`/`toBase` (rate defaults to 1) |
| Extra fields | `roiPct` (`netPnl / spent * 100`, or 100 when only earnings, else `null`) | `interestOwed` |
| Shared | kinds `investment`, `expense`, `income`; `netPnl = earned - spent`; `netPosition = invested - spent + earned` | same |

The two agree only when every project-tagged ledger row is in a currency whose
rate is 1 (the default base `BDT`, or a currency with no stored rate). For a user
with rows in, say, USD and a stored rate, the public receipt and the Finance
P&L page already show different numbers for the same project. The code comment
claiming they are "kept in lockstep" is stale. The receipt PDF also prefixes every
amount with `$` regardless of currency.

**Decision.** For PRJ-04:

1. Finance gains a new application function with a per-project signature, for
   example `getProjectPnlSummary(userId, projectId)`, owned by Finance. It does not
   exist yet and is not created in PRJ-01.
2. Its first version reproduces the current `computeProjectPnlSummary` arithmetic
   exactly, including no currency conversion, so receipts do not drift. Projects
   `application/roi-receipts.ts` then calls it instead of querying
   `finance_ledger_entries`. This removes the direct ledger read and the
   duplicated arithmetic without changing any number.
3. Whether receipts should convert to base currency, like `/finance/investments`,
   is a separate numeric-behavior decision. If taken, it is declared, approved and
   tested as a change, not folded into the extraction.
4. Characterization tests land before the move: single-currency parity against
   `/finance/investments`, multi-currency divergence pinned as current behavior,
   `roiPct` edge cases (`spent = 0` with and without earnings), token idempotency
   and revoke.

**Until then.** `finance_ledger_entries` read from `routes/projects.ts` is a
recorded foreign-table edge (resolving phase PRJ-04). No Finance import is
allowed from Projects, and the allowlist has no Finance entries. A new Finance
import fails the gate.

**Reverse coupling, recorded.** `finance/application/reports.ts` and
`routes/finance.ts` read `projects` (project names for per-project rollups).
Finance does not import Projects code (verified). PRJ-04 must decide whether
Finance keeps reading `projects` directly or receives names through a Projects
contract.

## Dependency direction

```
routes/projects*.ts  ->  projects/application  ->  projects/domain
                                  |
                                  +-> projects/infrastructure (own tables)
                                  +-> vault/application/kyc/enrollment, vault/security/kyc-ownership   (D1, pinned)
                                  +-> finance (new per-project use case, PRJ-04, parity first)         (D2, not yet allowed)
vault, finance  -/->  projects code      (zero edges today; table reads only)
```

## Dependencies that stay as they are

Not Vault or Finance, but part of the same extraction and not decided here:

- `lib/activity-log.ts` holds the SQL behind `getUserEnrollmentsOverview`,
  `getProjectEnrollmentsOverview`, `getUserEntitiesOverview` and
  `getSubjectActivitySummary`. `application/enrollment-overview.ts` will call it
  rather than absorb it; moving it is a separate decision.
- `services/sync.ts` (`syncOnProjectDelete`), `services/credit-meter`,
  `lib/receipt-theme`, `routes/events` (`broadcastEvent`) and the PEP/policy
  libraries remain shared infrastructure imports.
- `tasks`, `task_submissions` and `users` have no owning module, so no contract can
  be written for Projects' reads of them yet.

## Contract change control

Adding, removing or changing any entry in `allowedCrossModuleImports`,
`knownForeignTableEdges` or `knownExternalConsumers` is a deliberate manifest edit
in the phase that needs it, reviewed with the evidence file for that phase.
The validator treats both unlisted additions and stale entries as failures, so
the lists cannot drift in either direction.

## Decision D2' — Finance: Projects keeps its own P&L (supersedes D2, PRJ-04)

**Decision.** Projects owns project-level ROI, P&L and the public receipts. It does not call Finance and Finance
gets no new function. The single read of `finance_ledger_entries` lives in
`projects/infrastructure/repositories/project-ledger-reader.ts`: a raw `SUM(amount)` per kind for one user and
project, exactly the query the route ran. The arithmetic (`computeProjectPnl`, `roiPct`) is in
`projects/domain/roi.ts`.

**Why this replaces D2.** D2 assumed receipt math should live in Finance and be called from Projects. The
project-owner question was: Projects already has its own ROI and P&L code, so why move it? That is correct, and
the PRJ-01 finding supports it: the Projects figure and the Finance figure are different calculations
(raw sums and `roiPct` versus base-currency conversion and `interestOwed`), so there is no duplicate to
deduplicate, only a stale comment to correct (done). Keeping the math in Projects gives zero numeric drift and
removes PRJ-04's dependency on Finance's unverified WP-8/WP-9 pack.

**Cost, stated plainly.** Projects still reads another module's table directly (one query, one file, recorded).
If Finance's ledger columns change, that query must change with them. The validator pins that read to that one
file, so a second reader fails the gate.

**Still open.** Currency handling of receipts (convert like `/finance/investments`, or keep raw sums) is not
decided. Current behavior is pinned by tests.
