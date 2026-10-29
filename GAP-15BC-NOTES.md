# GAP-15 B + C (Equivalence replay + comparison)

Run: `pnpm validate:vault-equivalence:replay` (15-B) then `pnpm validate:vault-equivalence:compare` (15-C). Both fail closed, reject bypass flags, write validator-only evidence to `reports/antas/vault/gap/VLT-GAP-15/{replay,compare}.json`.

## Result
- 2221 old-vs-new cells (9 groups, 16 scenarios/route, health module-level), all equal, all deterministic.
- 4/4 planted divergences detected (status code, error message, db query arg, dropped event/notification).

## What is compared
Frozen baseline route files vs current route files (+ every vault/ module they load), same fake DB/events/audit/notifications/crypto, in call order: db calls, events, audit, side effects, encrypt/decrypt calls, authz decisions, status, body, headers, middleware chain.

## Known limits (carried to 15-D)
- Moved modules (crypto, pin-guard, backup audit/cloud/alerts/envelope, snapshot restore/payload/trash-purge, notifications, event hub) are the SAME fake on both sides: route/use-case code around them is compared, their internals are not (differentials 08/12/13-E cover some).
- 4 routes only reach shallow paths (allowed_shallow in config, with reasons).
- 6 dimensions have call sites never executed (open_for_15_D in compare.json); 3 of them have no passing differential.
- differential-vlt-gap-06-D / 09 / 11 no longer run against the current tree (stale resolver / mock layout). Not edited; do not count as evidence.
- Stand-in values: AUTH_STEP_POLICIES, CLOUD_PROVIDERS, retention days.
- No-auth scenario dropped (requireAuth answers first; middleware chain still compared).
- Not run: tsc / unit tests (no node_modules in this sandbox).

Changed: harness.mjs (two optional hooks env.dflt / env.autoReturn, backward compatible), package.json (2 scripts).
New: equivalence-replay.mjs, equivalence-suite.mjs, gap-configs/vault-equivalence-replay.json, validate-vlt-gap-15-B.mjs, validate-vlt-gap-15-C.mjs.
