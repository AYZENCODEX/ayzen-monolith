# VLT-GAP-13 E — marketplace-vault.ts extracted into vault/shared

routes/marketplace-vault.ts (332 lines, 63 violations) -> 53-line thin adapter (5 handlers, route table unchanged).

| New file | Owns |
|---|---|
| vault/shared/marketplace/use-cases.ts | list / create / buy / cancel / stats bodies (validation order, status codes, bodies, fee maths unchanged) |
| vault/shared/index.ts | `vault/shared/**` = Vault logic other apps integrate with (marketplace now; wallet, mail… later) |
| vault/infrastructure/repositories/vault-market-repository.ts | all SQL incl. the purchase transaction (debit → credit → sold → asset transfer → txn record → COMMIT) |
| vault/security/market-listing-ownership.ts | seller-OR-admin cancel decision (PolicyEngine + authorize), `canCancelVaultListing` |

Game asset listing/transfer still goes through vault/application/game/listing; it is injected into the repo transaction as a callback (no infrastructure -> application import).

Scanner: scope now includes marketplace-vault; owner-import allowlist now includes `/vault/shared/`.
Gate (13-D): the EXCLUDED list is empty; D also runs the new differential.
Result: 17 route files, 149 handlers, 0 violations.

Differential (scripts/antas/vault/gap/differential-vlt-gap-13-E.mjs, `pnpm validate:vault-routes:differential`, in both CI pipelines):
the frozen pre-extraction route (reports/.../VLT-GAP-13/baseline/marketplace-vault.pre-extraction.ts) and the new code run
against the same scripted fake DB — 49 scenarios (statuses 200/400/403/404/409/500, every asset type, every purchase
failure/rollback path, admin vs non-admin `official`, array id param). Status, body, full SQL+param sequence incl.
BEGIN/ROLLBACK/COMMIT and the authorize() call must be identical. Mutation-checked: fee maths, error text, admin check,
status code, ORDER BY and param order each made it fail.

Caveats: no node_modules in the upload, so tsc was not run on the project (the differential transpiles with TypeScript but
does not type-check). Earlier sealed validators (04-x, 12) already fail on the gap12 base (diff-audit/tsc) and were not changed.
