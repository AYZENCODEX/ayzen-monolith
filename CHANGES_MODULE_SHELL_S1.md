# CHANGES_MODULE_SHELL_S1

Module Shell Split — Season 1: registry unification, fyra, URL helpers.
Roadmap: "AYZEN Module Shell Split — Season Roadmap" (8 pages). One season, one phase; Season 2 NOT started.

## What changed

1. fyra added as its own module, fully separate from ryft.
   - artifacts/ayzen/src/lib/subdomain-app.ts
     - new entry `fyra` (label Fyra, homePath /finance, routePrefixes ["/finance"], kind "module", order 3, description).
     - ryft entry: "/finance" removed from routePrefixes; the stale "Investment stays inside Ryft" comment rewritten (Investments routes are fyra's now; no route renamed, pages stay where they are).
     - SubdomainApp interface extended with optional `icon` (lucide ComponentType), `description`, `order`, and required `kind: "module"`. Existing fields kept.
   - artifacts/api-server/src/lib/shared-apps.ts
     - SharedAppId union now includes "fyra".
     - new definition row: id fyra, label Fyra, homePath /finance, routePrefixes ["/finance"], hostEnv FYRA_HOSTS, defaultHost fyra.ayzen.tech.
     - ryft row: "/finance" removed from routePrefixes. Ryft keeps /wallet, /wallets, /admin/tools/wallet.

2. /admin/team-vault double claim resolved → sylo owns it (the page serves vault data; verified in route-config.tsx line 239 and both registries had it on sylo and warde). Removed from warde's routePrefixes on both sides. No route renamed.

3. URL helpers added to subdomain-app.ts (frontend):
   - getAllModules(): all modules sorted by `order` (declaration order breaks ties).
   - moduleUrl(id, path=""): https://<first configured host><path> in prod; dev/preview pattern preserved by swapping the first label of the current hostname (sylo.localhost, sylo-<replit-preview>).
   - centralUrl(path="/"): same idea for the main host.
   - getModuleForPath(path): longest-matching-prefix resolution, returns id or null.

4. Registry parity check: scripts/src/check-module-registry.mjs — fails when frontend and backend registries differ in ids, homePath or routePrefixes, or when one prefix is claimed by two modules. Wired into .github/workflows/ci.yml as a separate non-blocking job (continue-on-error: true) per the roadmap's "non-blocking warning first".

5. OIDC seed: scripts/src/seed-oidc-clients.ts — seedClient("fyra", "Fyra", { backchannelLogout: true }) added, same first-party PKCE pattern as the other split apps. No flow changed.

## Not touched
Sidebars (app-sidebar.tsx and friends), App.tsx, auth/JWT/session/OIDC code (beyond the one seed entry). DB-driven useNavConfig untouched.

## How to verify
- `node scripts/src/check-module-registry.mjs` → "module registry parity OK (8 modules, prefixes unique)".
- getModuleForPath: /finance/investments → fyra, /wallet → ryft, /admin/team-vault → sylo, /login → null (verified against the real registry data).
- `pnpm --filter @workspace/ayzen typecheck` — result is HONEST: 164 pre-existing errors on base commit 91c1c9d, 164 after this change; zero errors reference subdomain-app.ts or any touched file. Typecheck was already red before Season 1; this season adds no new errors.

## Rollback
Revert artifacts/ayzen/src/lib/subdomain-app.ts, artifacts/api-server/src/lib/shared-apps.ts, scripts/src/seed-oidc-clients.ts, scripts/src/check-module-registry.mjs and .github/workflows/ci.yml (single commit).
