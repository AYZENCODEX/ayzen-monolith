# VLT-GAP-18 — Anti-bypass / tamper gate (Hardening H1)

**Gate:** `pnpm validate:vault-tamper` -> `reports/antas/vault/gap/VLT-GAP-18/tamper-check.json`. Seal: `pnpm seal:vault-evidence` (writes `evidence-ledger.json`).
Blocking step in `.github/workflows/ci.yml` and `ci/enforcement-pipeline.yml`, after GAP-17. One script (`validate-vlt-gap-18.mjs`), no per-gate copies.

## What it proves
- **Bypass**: all 54 gate scripts (`validate-vlt-gap-*`, `differential-*`) run in a clean copy with `--skip-validation` and with `VALIDATION_DISABLED=true`: each exits non-zero, says "bypass", writes no evidence.
- **Integrity**: PASS in gate/retire-proof/extraction-proof/map-check must carry `source_hashes` + a `source_tree_sha256` equal to the hash of exactly those entries (a bare hand-written `{status: PASS}` is rejected).
- **Ledger**: `evidence-ledger.json` pins status + canonical sha256 (timestamps `*_at` ignored) of 63 evidence files. Hand-flipped status, deleted FAIL, or new unledgered PASS = FAIL. HMAC-signed if `VLT_EVIDENCE_HMAC_KEY` is set.
- **Regeneration**: gates 13, 13-C, 14, 14-C, 15-A, 16, 16-C, 17 re-run in a clean copy; every evidence file they rewrite must equal the committed one. Catches an edit even if the ledger was re-sealed over it.
- **`--seal` guard**: refuses FAIL->PASS unless that gate regenerated PASS in a clean copy; refuses removal of sealed evidence.
- **Mutations** (8 planted lies on a copy of the real tree, each caught by the intended detector).
- **Wiring**: package scripts + both pipelines run it as a plain blocking step.
- Fail closed: missing ledger/evidence dir, `--root` without value, bypass flags/env on the gate itself.

## Changed besides the new gate
- `validate-vlt-gap-15-D.mjs`: gate.json now also emits top-level `source_hashes` + `source_tree_sha256` (it only had a nested `binding`, so its PASS was indistinguishable from a forged one). 15-D re-run, evidence regenerated.
- `ci-wiring.json` for 13/14/16 regenerated (the CI files changed); ledger sealed after.

## Workflow after this
Any legit change to a gate or CI file: re-run the affected gates, then `pnpm seal:vault-evidence` (reviewed). Set `VLT_EVIDENCE_HMAC_KEY` as a CI secret to make the ledger signed.

## Limits (also in the report)
- Unsigned ledger is tamper-evident, not tamper-proof: someone with write access can re-run `--seal` for PASS->PASS or brand-new files. FAIL->PASS flips and reproducible-evidence edits are still caught.
- Evidence the fast gates cannot regenerate (04, 07-12 point-in-time proofs, heavy -D wrappers) rests on ledger + integrity shape.
- First seal is trust-on-first-use; it pinned the FAIL entries for GAP-04 as they were. Open items from GAP-17 (04 FAIL, 07 no evidence, 08/09/10 no retire proofs, 5 origin-unproven) are unchanged and belong to GAP-21.
- 16 source_hashes in trusted evidence point at files changed since the evidence was produced (listed in the report, informational).
