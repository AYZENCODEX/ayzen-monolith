# VLT-GAP-17 — Migration map truth gate (what changed)

**Gate:** `node scripts/antas/vault/gap/validate-vlt-gap-17.mjs` (`pnpm validate:vault-map`, `:self-test`) -> `reports/antas/vault/gap/VLT-GAP-17/map-check.json`.
Blocking step in `.github/workflows/ci.yml` and `ci/enforcement-pipeline.yml`. Lean roadmap: one script + one shared module, no per-sub-phase validators.

## What it proves (map claim vs. tree)
- Coverage: every `vault/**` file (138) is a NEW path in some row; every `routes/vault*.ts` / `lib/vault-*.ts` still on disk is an OLD path in some row.
- RETIRED: old file absent (or a documented re-export-only shim) AND nothing imports it — relative imports that resolve to nothing, and path strings in yml/json/sh, count.
- EXTRACTED: new owner exists with real code (AST, not import-only); any old file still on disk imports it (transitively) and makes no `db.*()` / `sql` calls (AST, so comments don't trip it).
- NEW-SEAM: reason required; "barrel" rows must be re-exports only. IMPLEMENTED only with an explicit "pending"; "pending" anywhere else is rejected.
- Evidence: a row citing VLT-GAP-NN must be marked UNCERTIFIED unless recorded evidence is PASS, and a stale UNCERTIFIED marker is rejected too.
- Report records symbols moved, callers of each new owner outside vault/, and remaining importers of each old path.
- Fail closed: missing map/tree, bypass flags/env, `--root` without a value. Self-test: 17 cases (planted lies in copies of the real tree).

## Map changes
- `scripts/antas/vault/gap/generate-vlt-gap-17-map.mjs` (`pnpm generate:vault-map`) wrote 71 per-file rows between the GENERATED markers (map had covered 45/138 files).
  OLD = family legacy files that reach the new file through imports today. It does not invent origins.
- 55 of those are EXTRACTED via import reach; 9 are barrels/facades; 5 are NEW-SEAM with "origin unproven"
  (kyc/enrollment, kyc/exchange, local-account/bulk, local-account/value, infrastructure/crypto-key-stores) — consumed by non-route code.
- GAP-08/GAP-09 RETIRED rows were tagged UNCERTIFIED (see below).

## Open items the gate surfaces (not fixed here — they belong to other GAPs)
1. VLT-GAP-04 `gate.json` and `extraction-proof.json` record FAIL (stale sealed baselines / later changes). Rows citing 04 are UNCERTIFIED.
2. VLT-GAP-07 has no evidence at all (07-A needs git HEAD; the upload has no .git). The AES-GCM row stays "IMPLEMENTED ... validation pending".
3. VLT-GAP-08/09/10 have only extraction-proof.json. Their point-in-time retire validators now fail on the current tree because GAP-12 later changed the moved files.
   Structure (old files gone, zero importers) is verified by this gate; the recorded retire proofs are missing.
4. 5 origin-unproven files above.
GAP-21 (final certification) should require pending = 0, uncertified = 0, origin-unproven = 0.

## Limits
- Evidence binding: no git repo in the upload, so evidence carries `source_tree_sha256`; the gate checks presence + status, not that the bound tree equals today's.
- "Moved unchanged" claims are not re-proved here (that is the per-GAP extract stages' job); this gate checks the map is true about locations, imports and status.
