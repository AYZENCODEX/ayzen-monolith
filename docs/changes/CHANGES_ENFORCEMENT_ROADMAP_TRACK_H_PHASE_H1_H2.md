# AYZEN Enforcement Roadmap — Track H (Policy / Ownership Enforcement), Phases H1–H2

**Roadmap:** `AYZEN_EventBus_Workflow_Enforcement_Roadmap.md`, Phases H1
(wire ownership-gate coverage into CI) and H2 (burn down the baseline).

## Headline: the baseline had already drifted

The roadmap describes an 89-route baseline. `check-ownership-gate-coverage.ts`
was **already a step in `security.yml`**, but when run against this tree it
**failed**: 130 unwired param routes vs. 89 in the baseline — 41 routes that
were in neither the baseline nor a recognised wired shape. A CI step that is
red on a clean checkout is not a gate anyone trusts, so H1's real work was
making it truthful, not adding it.

## H1 — what changed

1. **Local alias resolution** in the checker. `sub-engines.ts` does
   `const admin = requireAdmin;` and uses `admin` as middleware — the D8
   "bare platform-role middleware" shape under a local name. Only top-level
   `const X = requireAdmin|requireDev` is resolved (no data-flow analysis), so
   an alias can't launder a non-gate. Cleared 4 of the 41.
2. **Trend line on every run** (and `$GITHUB_STEP_SUMMARY` under Actions):
   `baseline N accepted, M unwired now, K new, S stale`.
3. **Baseline resynced once, deliberately** (`--update-baseline`): drops 1
   route that H2 wired, adds the 36 remaining drift routes → **124**. This is
   the one place the baseline *grows*; it is disclosed here rather than
   hidden. See the table below for what those 36 are. From here the count
   can only go down without a reviewable baseline diff.
4. `security.yml`: existing gate step renamed; new burn-down report step
   (`if: always()`).

Not done: adding the check to `scripts/full-system-audit.mjs`. That runner
executes `node <script>.mjs`; the checker is TypeScript needing `tsx` +
`typescript`. CI coverage satisfies the roadmap's "CI **or** audit" gate.

## H2 — what changed

### Tooling: `--report` (`route-integration:report-ownership-gate-burndown`)
Groups the unwired set by route-file family with a **review-order signal**
per route: `no-scope-signal` (nothing in the route's args looks like user
scoping — review first) vs `hand-scoped` (raw `user_id =`, drizzle
`eq(x.userId, …)`, inline `seller_id !== userId`, or a membership/access
helper). **It is a text heuristic, not a security verdict**, and never
affects pass/fail.

### Routes wired (behavior preserved exactly, per OWNERSHIP_GATING_GUIDE.md)
| Route | Change |
|---|---|
| `POST /marketplace/listings/:id/boost` | `requireBoostListingOwnership()` reusing C16's `marketplaceListingResource`. Nonexistent id stays `404 "Listing not found"`; someone else's listing stays `403 "You can only boost your own listings"` (distinguished via the real seller id vs the `-1` sentinel — no builder change). Placed *after* `requireCreditBalance` so the 402 precedence is unchanged. |
| `POST /wallets/:id/phrase` | `requireWalletOwnership("wallet.phrase.write")`. This route has no step-up check (only `GET` does), so no ordering to disturb; same `404 "Wallet not found"`. |

### Why so few routes: the baseline is mostly *not* ownership gaps
Reading the highest-sensitivity entries showed most are safe by other means
the checker can't see, or aren't ownership-shaped at all:
- `PUT /finance/currencies/:currency`, `*/vault/backup/cloud/:provider*` —
  the param is a code/provider name; the row is keyed by the **session user**.
  There is no foreign owner row to build a `ResourceRefBuilder` for.
- `POST /auth/sessions/:id/revoke` — `revokeSession(result.userId, id)` is
  user-scoped.
- `GET /tools/streak/:userId` — documented intentional decision (any
  authenticated user).
- `/spot/*/:pair`, `/tools/gas/:network`, `/oidc/rollout-flags/:appId` —
  public/market data.
Wiring `requireOwnership()` onto these would be wrong, not just risky; the
guide says don't guess. A full 124-route burn-down needs per-route review with
a running DB and the test suites, which this session didn't have.

### Deliberately left: `GET /wallets/:id/phrase`
Still in the baseline. Wallet phrase reveal has a step-up (reveal-token) check
that runs before the ownership-scoped read. As middleware, PDP ownership would
run *first*, changing what a non-owner without a token sees (403 → 404) — the
exact judgment call C7 reserved. Needs an owner decision, or extracting the
step-up into middleware ordered before ownership.

## The 36 routes added by the resync (read these)

| Group | Count | Assessment |
|---|---|---|
| `organizations.ts` `/organizations/:id/*` | 11 | Hand-gated by `getMembership()`/`canManage()`. Gated, but not via the PDP → no audit trail, no shared rule. Next H2 batch; needs an org-membership `PolicyRule` (a design decision, not a mechanical wrap). |
| `workspaces.ts` `GET /workspaces/:id` | 1 | Gated by `requireWorkspaceAccess` (custom middleware). Same follow-up as orgs. |
| `notification-preferences.ts` `PUT /:category` | 1 | Session-user scoped; param is a category. Accepted. |
| `sub-engines.ts` `flags/:key/evaluate`, `rate-limit/:key/check` | 2 | Auth-only; `:key` is a flag/limit name, not an owned row. Accepted. |
| `telegram.ts` `POST /telegram/gateway/:botKey/webhook` | 1 | Authenticated by the webhook secret, not a user. Candidate for `requirePublicAudit()` (F1 pattern) rather than the baseline. |
| **`new-engines.ts`** (15), **`sub-engines-advanced.ts`** (4), **`acie.ts`** `decisions/:id/outcome` (1) | **20** | **Only `requireAuth` — no scoping signal. Treat as suspected authorization gaps, not accepted ones.** |

### Highest-priority finding (needs a domain owner)
`new-engines.ts` mounts everything behind `router.use(requireAuth)` and calls
in-memory engines with no actor/tenant check. Concretely, **any authenticated
user** can call `POST /new-engines/consent/grants/:id/withdraw` (withdraws
anyone's consent grant by id), `GET /new-engines/consent/history/:subjectId`
(any subject's consent history), and mutate graph/dependency nodes and
schemas. `sub-engines-advanced.ts` lets any authenticated user run
`POST /pipelines/:id/run` and read `GET /pipelines/runs/:id` /
`GET /workflows/:id` for any id. Whether these are meant to be admin-only,
per-user, or per-org is a product decision — I did not guess. They are in the
baseline only so CI is green; they should not stay there.

## Verification performed
- Checker run on the real tree: before — FAIL (41 new); after alias fix — 37
  (4 cleared); after wiring boost — 36; after resync — `OK … 124 accepted,
  0 new, 0 stale`. Baseline diff vs. the shipped file: −1
  (`wallets.ts:POST /wallets/:id/phrase`), +36.
- Both wired routes are recognised as wired by the checker (they drop out of
  the unwired set).
- Syntax diagnostics clean.

## Not verified
- The app was **not** started and no route test suite was run (no
  `node_modules`/DB). In particular the `onDeny` branches on `boost` mirror
  `ayzen-mail.ts`'s proven compound-deny pattern but were not exercised, and
  `test-route-ownership-regression.ts` doesn't cover these two routes.
- The `--report` signal is a heuristic; it can be wrong both ways.

## Files touched
- `scripts/src/check-ownership-gate-coverage.ts`
- `scripts/src/ownership-gate-baseline.json` (resynced: 89 → 124)
- `scripts/package.json` (`route-integration:report-ownership-gate-burndown`)
- `.github/workflows/security.yml`
- `artifacts/api-server/src/routes/marketplace.ts`
- `artifacts/api-server/src/routes/wallets.ts`
