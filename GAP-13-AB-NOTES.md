# VLT-GAP-13 A–B — what changed

A (scanner): scripts/antas/vault/gap/validate-vlt-gap-13.mjs — AST route-thinness scan (R1–R9) + --self-test.
  Baseline on your gap12 zip: 44 violations in 4 files (vault-shares 25, vault-migration 9, vault-attachments 6, vault 4).
B (extraction/rewire): all 44 cleared. Result: 16 route files, 144 handlers, 0 violations; self-test PASS (10 planted cases).

| Route | Change |
|---|---|
| vault-shares.ts (481→93 lines) | rewired to existing share/use-cases (GAP-10 had extracted them; route never delegated) |
| vault-attachments.ts (172→81) | rewired to existing attachment/use-cases; respondWithAttachmentResult added there |
| vault-migration.ts (224→48) | NEW vault/application/migration/use-cases.ts (export/import moved verbatim) |
| vault.ts | runHealthCheck + health-report + health-check -> NEW application/entity/health-check.ts; broadcastEvent via provider-ports (fixes R7 route-to-route) |
| vault-snapshot.ts + snapshot/use-cases.ts | your uploaded versions (respondWithSnapshotResult moved into use-cases) |

Not changed: repository `*ForModule*` duplicates (GAP-12 leftovers, now unused by routes) — GAP-16 duplicate elimination.
