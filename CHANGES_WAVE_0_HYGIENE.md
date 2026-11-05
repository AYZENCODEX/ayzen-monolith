# Wave 0: Hygiene (W0-P1, W0-P2, W0-P3)

Roadmap: `AYZEN Monolith: Audit + Full Roadmap` (2026-11-04). No DB migration in this wave (migration number: none).

## W0-P1: Gitleaks (req 15, step 1)
- `.gitleaks.toml`: extends upstream defaults; allowlist = `reports/`, `pnpm-lock.yaml`, `fixtures/` dirs, `*.enc.*`, `.sops.yaml`, `.env.example`.
- `.githooks/pre-commit` + `pnpm hooks:install` (sets `core.hooksPath`). Scans staged changes only. Skips with a warning if gitleaks is missing; `AYZEN_REQUIRE_GITLEAKS=1` makes that fatal.
- `.github/workflows/security.yml`: new blocking `gitleaks` job (full history, `--baseline-path reports/gitleaks/baseline.json`) on PR, push to main, nightly 02:43 UTC and manual dispatch. The old two-pattern `rg` scan is kept.
- `reports/gitleaks/baseline.json` starts empty; see `reports/gitleaks/README.md`.
- **Real finding fixed in HEAD:** `scripts/migrun.mjs` and `scripts/migrun2.mjs` contained a hardcoded Supabase pooler connection string with a password. Both now read `APP_DATABASE_URL` / `DATABASE_URL`.

### Action required (cannot be done from code)
1. **Rotate the Supabase database password now.** It is still in git history (commits `ea30c97`, `79b7e46` and descendants). Removing it from HEAD does not revoke it.
2. Run a full-history scan locally, triage, then generate the baseline (command in `reports/gitleaks/README.md`). Until the password is rotated and the finding baselined, the new CI `gitleaks` job is expected to fail on that history. That is the gate working.
3. Done-check from the roadmap: push a throwaway branch with a fake `AKIA...` key and confirm CI goes red.

## W0-P2: ADR freeze
- `docs/architecture/ADR-W0-FREEZE.md`: A1-A8 and Q1-Q8 with the audit's recommendations. Status is PROPOSED; the Decision column is for the owner.

## W0-P3: Module registry single source
- New `packages/module-registry` (`@ayzen/module-registry`): id, label, uidPrefix, order, description, homePath, routePrefixes, host env/default, telegramBot, oidcClientId, reserved `clerkApp`/`mcpEndpoint`.
- `artifacts/api-server/src/lib/shared-apps.ts` and `artifacts/ayzen/src/lib/subdomain-app.ts` now derive from it; exported APIs unchanged.
- **Behavior note:** the old backend copy listed `/admin/team-vault` under both sylo and warde (the old parity check could not see multi-segment prefixes). Registry gives it to sylo only, matching Module Shell Split S1. Request routing is unchanged because sylo was already first in the lookup.
- `scripts/src/check-module-registry.mjs` rewritten: registry invariants (unique id/prefix/host/order, 3-letter uidPrefix, no overlapping prefixes, homePath inside own prefixes), consumers must not re-declare, OIDC seed ids and Telegram bot keys must match. `--self-test` included. Wired into `ci.yml` (install-free job) and `pnpm validate:module-registry`.
- Test change: `module-settings-paths.test.ts` checks the registry instead of regex-parsing `subdomain-app.ts`.

## Rollback
Revert this change set. No data or schema is touched. The git-hook is opt-in per clone (`git config --unset core.hooksPath`).
