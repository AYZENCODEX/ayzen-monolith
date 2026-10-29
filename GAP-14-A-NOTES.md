# VLT-GAP-14 A — architecture scanner + baseline

A = detection only (like 13-A). Nothing in vault/ or routes/ was changed; fixing is 14-B, CI wiring is 14-C, CI-fail proof is 14-D.

New:
- scripts/antas/vault/gap/validate-vlt-gap-14.mjs — TypeScript-AST import graph of all api-server/src (654 files, 2,972 imports; handles import / export-from / import type / dynamic import() / require / import=), Tarjan SCC cycle detection, line-level violations, `--self-test`.
- scripts/antas/vault/gap/gap-configs/vault-architecture.json — the allowlist/denylist (layer matrix, banned externals per layer, route/middleware layer, legacy shims, composition roots, cross-feature public surface). Rules are edited here, not in the scanner.
- reports/antas/vault/gap/VLT-GAP-14/{import-graph.json, architecture.json, ci-fail-proof.json}
- package.json: validate:vault-architecture, validate:vault-architecture:self-test (NOT in CI yet — it would fail; 14-C wires it after 14-B).

Rules: A0 unresolved import · A1 runtime cycle · A2 layer direction · A3 domain purity · A4 banned external (db/http/provider/frontend) · A5 route/middleware dependency · A6 cross-feature private import · A7 legacy implementation import · A8 outside deep import.
Layer chain: api → shared/application → security → domain/crypto → infrastructure (matrix in the config). Type-only imports are checked too and flagged `type_only: true`; type-only cycles are ignored (erased at runtime).

Self-test: 24 cases — clean tree (incl. type-only cycle, composition root, `.mjs` workspace package, barrel) accepted; every rule planted and caught; empty/missing Vault root fails closed. Bypass flags/env rejected.

Baseline on your tree: 40 violations, 0 runtime cycles
| Rule | # | Where |
|---|---|---|
| A2 layer direction | 4 | crypto→infrastructure (backup-envelope:72, field-encryption:17); infrastructure/index.ts→application (2) |
| A3 domain purity | 1 | domain/entity-links → lib/policy/pep/types |
| A4 db | 7 | application: schedule-cron, analytics (dynamic), links, auth-policy (value import AUTH_STEP_POLICIES), reauth, status; domain/entity/fields — 6 are type-only |
| A4 http | 10 | application ×8 + domain/entity-links + infrastructure/backup/audit — all type-only express Request/Response |
| A5 route | 7 | vault/api/index.ts→4 routes; infrastructure: alerts→routes/notifications, provider-ports→routes/notifications, routes/events |
| A6 cross-feature | 8 | backup→snapshot (2), health/health-scan→entity/representation, secret→entity (3), shared/marketplace→application/game/listing |
| A8 outside deep import | 3 | lib/vault-pin-guard (legacy shim), routes/organizations→share-entity-types, routes/vault→provider-ports |
| A1 cycles / A7 legacy / A0 | 0 | |

Judgment calls (change in the config if you disagree): crypto→infrastructure is flagged (key persistence should come through a port); src/index.ts, worker.ts, app.ts are composition roots exempt from A8; index.ts barrels are exempt as A6 importers; `public_surface` is empty so every cross-feature file import counts until 14-B adds feature barrels or lists public files; node:crypto is not banned (A4-provider covers fs/net/http/mail/cloud SDKs); `.mjs` imports of packages/vault-crypto are recorded, not flagged.
