# AYZEN — Deep Codebase Audit (2026-09-22)

> Static audit of the source tree as delivered (`.git`, `node_modules`, and
> build caches excluded). No runtime, database, or CI access — findings are
> based on file structure, static grep/AST-level scans, and cross-reads
> against the existing `docs/architecture/*` and `docs/inventory/*` docs.
> Line numbers and counts below are reproducible against this snapshot.
>
> **Snapshot note:** this audit was run against the `ayzen-phase0-sourcezip`
> export. This copy of the repo has since added `packages/authorization`,
> `packages/capabilities`, `docs/architecture/adr-003-identity-authorization-
> capability-boundaries.md`, `docs/architecture/api-capability-registry.md`,
> and `docs/architecture/phase-1-11-implementation.md`, and updated several
> `packages/*` and `apps/*` files. The findings below (test coverage, `any`
> usage, route file sizes, the duplicate `034` migration, the dual migration
> mechanism) have not been re-verified against those specific additions —
> ask for a re-run if you want numbers current to this exact upload.

## 1. Scope & method

- Full repo walk: 3,759 files pre-audit / 1,801 after excluding `.git`,
  `*.tsbuildinfo`, and build caches (see project export note above).
- 253,678 lines of TypeScript/TSX across the workspace.
- Reviewed: root `package.json` / `pnpm-workspace.yaml`, all 11 `services/*`
  scaffolds, all 15 shared `packages/*`, `apps/*`, `artifacts/api-server`
  (the monolith), `artifacts/ayzen` (frontend), `migrations/*.sql` (104
  files), and the existing `docs/` tree.
- Heuristic scans: hardcoded secrets, `TODO`/`FIXME`/`HACK`, `console.log`,
  `any`-typing, raw SQL string interpolation, migration numbering integrity,
  test file coverage, and service scaffold consistency.

## 2. Executive summary

AYZEN is a **modular monolith mid-migration to services**, exactly as
`docs/architecture/current-state.md` describes. The monolith
(`artifacts/api-server`, 545 files / ~104k lines) owns essentially all real
business logic and database access; the 11 packages under `services/*` are
still thin scaffolds (2–3 files each, no tests, no Dockerfiles) and the 15
shared `packages/*` are single-file stubs. This is consistent with a
deliberate, reversible extraction strategy — it is not accidental drift.

The codebase is in reasonably disciplined shape for its size: no hardcoded
secrets found, `console.log` is fully absent from `services/packages/apps/
artifacts/lib` (structured logging is used instead), rate-limiting/helmet/
CORS/auth middleware all exist, and `packages/config` enforces a
secret-name filter before anything reaches `publicConfig()`. The main risks
are **test coverage**, **file-size/complexity concentration in a handful of
route files**, **type-safety erosion via `any`**, and **two parallel
migration mechanisms** that need a documented reconciliation story.

| Area | Verdict |
|---|---|
| Secrets hygiene | Good — none found in source |
| Logging discipline | Good — no stray `console.log` |
| Network/API security middleware | Good — present and used |
| Automated test coverage | **Critical gap** — 7 test files / 832 source files |
| Type safety | **High concern** — 1,980 `any` occurrences |
| Route file size / complexity | **High concern** — several 1,000–3,000 line handlers |
| Migration integrity | **Medium concern** — 1 duplicate sequence number, 2 migration systems |
| Service-scaffold consistency | Low concern — 2 of 11 missing README, none have tests/Dockerfiles (expected at this phase) |
| Config/env handling | Good — typed, validated, secret-redacting |

## 3. Findings

### 3.1 Critical — near-zero automated test coverage
Only **7** `*.test.ts`/`*.spec.ts` files exist against **832** non-declaration
`.ts` files under `services/`, `packages/`, `apps/`, `artifacts/`, `lib/`
(≈0.8% file coverage). The monolith's largest, highest-risk modules — finance,
vault, mailbox, auth, OIDC — have no visible test files at all in this
export. For a system already handling finance, vault/backup, and
OIDC/identity, this is the single highest-priority gap: regressions in these
paths are the most expensive kind to catch late.
**Recommendation:** prioritize test coverage for `routes/finance.ts`,
`routes/vault.ts`, `routes/auth.ts`, and the OIDC/policy libs before further
feature work there; add a CI gate that fails on coverage regression for
`artifacts/api-server/src/lib/policy/**` and `routes/finance*.ts` specifically.

### 3.2 High — route-handler files are large, single-responsibility violations
Several route files concentrate enormous surface area in one file:

| File | Lines |
|---|---|
| `artifacts/api-server/src/routes/finance.ts` | 2,961 |
| `artifacts/api-server/src/lib/schema-migrations.ts` | 2,750 |
| `artifacts/api-server/src/routes/ayzen-mailbox.ts` | 2,580 |
| `artifacts/api-server/src/routes/vault.ts` | 1,975 |
| `artifacts/api-server/src/routes/teams.ts` | 1,968 |
| `artifacts/api-server/src/routes/nav-seeds.generated.ts` (auto-generated, low concern) | 1,393 |
| `artifacts/api-server/src/routes/projects.ts` | 1,331 |
| `artifacts/api-server/src/lib/oidc-logout-propagation.ts` | 1,215 |

15 files exceed 800 lines; average file size across the monolith is a
healthy 192 lines, so this is a concentrated problem in ~15 files rather
than a systemic style issue. These are also exactly the files least likely
to have test coverage (finance, vault, mailbox above). **Recommendation:**
split `finance.ts`, `ayzen-mailbox.ts`, `vault.ts`, and `teams.ts` by
sub-resource (e.g. `finance/invoices.ts`, `finance/ledger.ts`,
`finance/payouts.ts`) before they grow further — this is also a prerequisite
for making them testable in isolation.

### 3.3 High — 1,980 `any`-typed occurrences
`: any` / `as any` appears 1,980 times across `services/packages/apps/
artifacts/lib`. In a strict, contract-driven system (there's a dedicated
`packages/contracts` and `packages/domain-boundaries` package, implying a
type-safety-first intent), this volume suggests real erosion — likely
concentrated around DB row shapes, third-party SDK responses (Telegram,
Stripe-replit-sync, `@replit/connectors-sdk`), and error catch blocks
(`catch (err: any)`, seen in `dr-test-db.ts`, `schema-migrations.ts`).
**Recommendation:** run a scoped `any`-elimination pass file-by-file
starting with `lib/policy/**` and `routes/finance*.ts`, since those are the
authorization- and money-handling paths where a wrong type is most costly.

### 3.4 Medium — two parallel database-migration mechanisms
There are **two independent migration systems**:
1. `migrations/*.sql` — 104 numbered SQL files (5,035 lines), the
   conventional migration directory already documented in
   `docs/inventory/migrations.md`.
2. `artifacts/api-server/src/lib/schema-migrations.ts` — a 2,750-line
   `MIGRATIONS` array of `CREATE TABLE`/`ALTER TABLE` statements run at
   boot (`waitForDbThenMigrate()`) *and* reused by the DR-test harness
   (`lib/dr-test-db.ts`) to stand up isolated schemas.

The in-code comment confirms this was a deliberate "pure extraction," and
the intent (single source of truth for DR-schema bootstrapping) is
reasonable — but it means production schema state now has two places that
must stay in sync: the numbered `.sql` directory or `MIGRATIONS`. If
`docs/inventory/migrations.md` only documents the `.sql` directory, this
split isn't visible to a new engineer without reading `schema-migrations.ts`
directly. **Recommendation:** add an explicit "why two migration paths
exist and how they're kept in sync" note to
`docs/inventory/migrations.md`.

### 3.5 Medium — migration numbering: one duplicate, four gaps
- **Duplicate sequence number 034**: both `034_finance_invoice_enterprise.sql`
  and `034_finance_networth_lending_investment.sql` exist. Whether this is
  safe depends entirely on the migration runner's ordering rule when two
  files share a numeric prefix (alphabetical fallback on the full filename,
  in this case) — if the runner assumes strictly unique sequence numbers,
  this is a latent ordering bug. **Recommendation:** rename one to `034b_`
  or renumber to the next free slot, and confirm the runner's tie-break
  behavior either way.
- **Gaps at 49, 69, 89, 90**: not necessarily a problem (could be
  intentionally retired/squashed migrations), but worth a one-line note in
  `docs/inventory/migrations.md` confirming they're deliberate so future
  readers don't assume missing files.

### 3.6 Low — 2 of 11 service scaffolds missing a README
`services/identity` and `services/intelligence` have no `README.md`, while
the other 9 services (`ai`, `finance`, `mail`, `marketplace`,
`notification`, `search`, `vault`, `workflow`, `_service-template`) do.
Given identity is one of the most architecturally significant extraction
candidates (per `docs/architecture/extraction-candidates.md`), its scaffold
being undocumented is a minor but avoidable inconsistency.
**Recommendation:** copy the `_service-template` README pattern into both.

### 3.7 Low / informational — SQL string-interpolation usage
75 files use parameterized `sql\`...\`` (Drizzle) or `pool.query(text,
params)` correctly. 24 files call `pool.query(\`...\`)` with a raw
template literal; nearly all of these pass parameters as a second array
argument (properly parameterized). The one direct string-interpolation
case — `lib/dr-test-db.ts`'s `CREATE SCHEMA "${schemaName}"` — is guarded by
`assertSafeSchemaName()` before use and only ever receives a
server-generated name for DR test isolation, not user input. **No action
needed**, noted here only so it doesn't get flagged again without context
in a future automated scan.

### 3.8 Positive findings (worth preserving, not just noting)
- No hardcoded secrets, API keys, or passwords found in source.
- `console.log` is completely absent from `services/`, `packages/`,
  `apps/`, `artifacts/`, `lib/` — structured logging is used consistently.
- `pnpm-workspace.yaml` enforces a 1-day `minimumReleaseAge` on npm
  installs — a real supply-chain-attack mitigation, with a narrow,
  documented exclusion list.
- `packages/config` provides typed `envString`/`envNumber`/`envBoolean`
  helpers with validation, and `publicConfig()` actively filters out any
  key matching `/secret|token|password|private|key/i` before exposing it —
  a genuinely good default-safe pattern.
- Security middleware (`middlewares/security.ts`, `middlewares/auth.ts`,
  `middlewares/api-key-scope.ts`), rate limiting, CORS, and helmet are all
  present in the monolith, not just referenced in docs.
- `routes/nav-seeds.generated.ts` is clearly labeled `AUTO-GENERATED`
  with the generator script named in a header comment — a good pattern
  that should be the model for any other generated file in the repo.

## 4. Metrics snapshot

| Metric | Value |
|---|---|
| Total TS/TSX lines | 253,678 |
| `artifacts/api-server` files / lines | 545 files / ~104,418 lines |
| Average file size (api-server) | 192 lines |
| Files over 800 lines | 15 |
| Route files in monolith | 150 |
| Test files vs. source files | 7 / 832 |
| `any`-typed occurrences | 1,980 |
| `TODO`/`FIXME`/`HACK` occurrences | 69 |
| `try {` blocks in `routes/*.ts` | 654 |
| Migration files / total SQL lines | 104 / 5,035 |
| Frontend (`artifacts/ayzen`) TS/TSX files | 392 |
| Shared `packages/*` | 15, each a single-file stub (expected — pre-extraction) |
| `services/*` scaffolds | 11, 2–3 files each, no tests/Dockerfiles (expected — pre-extraction) |

## 5. Priority order for follow-up

1. Test coverage on finance, vault, mailbox, auth/OIDC (§3.1) — highest
   blast radius if wrong.
2. Resolve the duplicate `034` migration prefix (§3.5) — cheap fix, real
   latent risk.
3. Split the largest route files, starting with `finance.ts` and
   `ayzen-mailbox.ts` (§3.2) — improves both testability and review safety.
4. Document the two-migration-system split in `docs/inventory/migrations.md`
   (§3.4).
5. `any`-elimination pass on policy/authorization and finance code paths
   (§3.3).
6. Backfill `README.md` for `services/identity` and `services/intelligence`
   (§3.6).

## 6. Out of scope for this pass

No access to a running database, CI pipeline, dependency vulnerability
database (`pnpm audit` equivalent), or the private `.git` history, so this
audit cannot speak to: actual test *pass* status, real dependency CVEs,
migration *execution* history, or code churn/ownership. A follow-up pass
with repo + CI access could close those gaps.
