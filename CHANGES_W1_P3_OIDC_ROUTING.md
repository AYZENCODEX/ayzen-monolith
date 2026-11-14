# W1-P3: OIDC provider routing complete (roadmap req 6)

Roadmap item: "Verify/mount register, introspect, revoke in app.ts; contract test oidc-conformance (discovery doc vs actual
routes). Issuer host fix, api-gateway route table, role-host.ts interaction check. Seed 8 module OIDC clients: redirect URIs
per module host, PKCE only, per-client scope. Done: every endpoint resolves, conformance test passes."

## What the audit found vs what was true

| Audit gap | Finding |
|---|---|
| register / introspect / revoke mount "unverified" | **Already mounted** in `app.ts` (before the `/api` stack and both role-host gates). Now pinned by the conformance test so it cannot regress. |
| gateway route table | **Already present**: `/oidc` and `/.well-known` -> `IDENTITY_SERVICE_URL` in `SERVICE_ROUTE_TABLE`, matched on a path boundary. Pinned by the test. |
| role-host interaction | `roleHostApiGate` only wraps `/api`; `roleHostPageGate` skips `/oidc` and `/.well-known` and exempts `/oidc/callback`. No change needed; pinned by the test (incl. mount order). |
| seed 8 module clients | Eight module clients + `workspace` were already seeded with per-host https redirects, public/PKCE-only. **Real bug found:** the seed `INSERT` never set `registration_status`, whose column default is `'pending'` (migration 091). Any client inserted after 091 (a fresh staging DB, or `fyra`/`skarn`/`warde` if added later) is rejected on every `/oidc/authorize` and `/oidc/token`. |
| issuer host | `id.ayzen.tech` **approved by the owner (2026-11-11)**; see `docs/architecture/ADR-W1-P3-oidc-issuer.md`. **Code default unchanged** until the rollout steps in the ADR are done. |

## Changes

- `lib/oidc-discovery.ts`: discovery now also advertises `registration_endpoint`, `code_challenge_methods_supported` (S256 only),
  `grant_types_supported` (`authorization_code` only), `token_endpoint_auth_methods_supported` (`none`, `client_secret_post`),
  `subject_types_supported`, `response_modes_supported`, `backchannel_logout_supported`, `claims_supported`, and `scopes_supported`
  widened from `["openid"]` to `openid profile email` (what the seeded clients and `/oidc/userinfo` already enforce). Each value mirrors
  existing enforcement and is checked against it by the conformance test. New `issuerProblem()`; `app.ts` logs `oidc.issuer.invalid` at boot.
- `scripts/src/oidc-seed-clients-data.ts` (new, pure): client definitions **derived from `@ayzen/module-registry`** (client id = `oidcClientId`,
  all URLs from `defaultHost`) with a per-module `MODULE_CLIENT_SCOPES` map (all equal today). `seed-oidc-clients.ts` re-exports it.
- `seed-oidc-clients.ts`: inserts `registration_status = 'approved'`; on conflict it turns a stuck `'pending'` into `'approved'` (repairing rows an older seed created) and leaves `'approved'`/`'suspended'` alone, so an admin's suspend survives a re-seed. It never touches the secret.
- `scripts/src/test-oidc-conformance.ts` (new, 28 tests, install-free): the contract in its header. Mutation-checked: 10 deliberate breakages (unmounted router, wrong path, router after a gate, missing gateway row,
  seed without status / resetting status, advertising `refresh_token` or `plain` PKCE, wrong module host, page gate no longer skipping `/oidc`) each fail it.
- `scripts/smoke-oidc-endpoints.mjs` (+ test): live check, `pnpm smoke:oidc https://<host>`.
- Updated tests that pinned the old shape: `test-oidc-discovery-metadata.ts`, `test-openid-configuration-endpoint.ts`. `test-seed-oidc-clients.ts` was stale (omitted `fyra`, which was already seeded) and now imports the pure data file.
- CI: new `oidc-conformance` job (`pnpm validate:w1-p3`). `.env.example` documents `AYZEN_OIDC_ISSUER`.

## Not done / caveats

- **Seeded rows already in a database are unchanged until the seed is re-run**; re-run `pnpm --filter @workspace/scripts oidc:seed-clients` (`:dry-run` first). Migration 091 only backfilled rows that existed then, so a client seeded afterwards may be sitting at `'pending'` in your database: `SELECT client_id, registration_status FROM oidc_clients` first, and the re-seed repairs any `pending` first-party row (never a `suspended` one). The dry-run output does not print status; check the SELECT.
- Per-client scope is structurally per-module but **values are identical** (`openid profile email`); narrowing needs a product decision on what each module needs. The scope validator only knows those three scopes.
- Dev/localhost redirect URIs are not seeded (production hosts only, as before).
- The conformance test reads `app.ts` and route files as text; it does not boot Express. The real "curl resolves" check is `smoke-oidc-endpoints.mjs` against staging, not run here (no network/deployment).
- Not run: the full api-server typecheck/build and the Express/HTTP layer (no installed deps in this sandbox). `docs/mcp.md` still says dynamic registration is unavailable for MCP OAuth; that statement is about the MCP flow (new clients are `pending` until approved) and was left alone.
- `/oidc/*` and `/.well-known/openid-configuration` have no rows in `packages/endpoint-registry` (only `jwks.json` does); left as is.
- Issuer flip: decided (`id.ayzen.tech`); activation still needs DNS/TLS, RP config and `AYZEN_OIDC_ISSUER` per the ADR.

## Manual smoke test (staging)

1. `pnpm --filter @workspace/scripts oidc:seed-clients:dry-run` then the real seed.
2. `curl -s https://<host>/.well-known/openid-configuration | jq` and `node scripts/smoke-oidc-endpoints.mjs https://<host>`.
3. Authorize+token round trip for one module client with PKCE (`/oidc/authorize` -> `/oidc/token`), then `/oidc/introspect` and `/oidc/revoke` with the issued token.
