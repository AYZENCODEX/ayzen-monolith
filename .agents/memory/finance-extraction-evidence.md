---
name: Finance extraction evidence boundary
description: The Finance extraction is complete in code but its final pack is BLOCKED; what ran, what did not, and how to re-verify.
---

The Finance extraction (WP-0 to WP-9) is complete in code: 109 route handlers are adapters over
`finance/application/*`, no `lib/finance-*` shim remains. `finance-final-validation.json` is BLOCKED because
`pnpm typecheck`, `pnpm build` and `pnpm test:finance-db` have not run at the WP-8/WP-9 revision, and there is
no commit SHA.

**Why:** Sessions that wrote WP-7 to WP-9 had no package registry and no Postgres. Static gates, the boundary
scan and `check-import-integrity.mjs` (names and relative files only, not types) cannot stand in for them.
The last full DB run (176/176, local Postgres 16) and the last clean `tsc` were at WP-6b.

**How to apply:** Do not mark any WP-1 to WP-9 evidence PASS until typecheck, build and the DB suite are green
in a real checkout with a bound commit SHA. Re-measure with
`node scripts/antas/finance/measure-final-state.mjs` instead of copying counts from docs. Open items:
`docs/antas/finance/finance-risk-register.md` (migration 123 rounds money data and is irreversible; take a
backup first).
