# AYZEN Enforcement Roadmap — Track G (OIDC Enforcement), Phase G3

**Roadmap:** `AYZEN_EventBus_Workflow_Enforcement_Roadmap.md`, Phase G3 —
"OIDC scope/consent enforcement at the route layer".

## Finding (a live gap, not a paper one)

`requireOidcScope()` (Phase 4d) and `evaluateScopeCreep()` (Phase 7e) were
real, unit-tested, importable functions, but nothing checked that routes
actually use them. `routes/oidc-userinfo.ts` (4c-f) was the proof:

- It imported nothing from `lib/oidc-scope-enforcement.ts`.
- It hand-rolled bearer extraction + `verifyOidcAccessToken()` + the
  revocation check inline (a copy of `requireOidcScope()`'s body).
- It **never checked the token's granted scopes.** Any cryptographically
  valid, non-revoked access token — including one issued for `profile` alone,
  with no `openid` — could read `GET /oidc/userinfo`. OIDC Core §5.3 says
  UserInfo is only for tokens obtained via the `openid` scope.

Every existing test still passed because none of them imported the real
`router` and looked at what Express registered.

## What changed

1. **`routes/oidc-userinfo.ts`** — now
   `router.get("/oidc/userinfo", globalLimiter, requireOidcScope("openid"), userinfoHandler)`.
   `userinfoHandler` no longer verifies anything itself: it reads
   `req.oidcToken` (set by the middleware), does the banned/suspended user
   lookup, and shapes claims. If it is ever mounted without the middleware it
   fails closed (401 `invalid_token`) rather than serving claims. The direct
   `verifyOidcAccessToken` / revocation imports are gone.
2. **`scripts/src/check-oidc-scope-enforcement-coverage.ts`** (new, static,
   no env vars) — (a) no `routes/oidc-*.ts` may import `verifyOidcAccessToken`
   directly; (b) every `router.<verb>("/oidc/...")` in the two resource-route
   files (`oidc-userinfo.ts`, `oidc-resource.ts`) must have
   `requireOidcScope(` in its argument list.
3. **`scripts/src/test-route-oidc-scope-wiring.ts`** (new, dynamic) — imports
   the real routers and walks `router.stack`. Deliberately named
   `test-route-oidc-*`, not `test-oidc-*`, so it stays outside
   `oidc:test-suite`'s DB-free glob. Needs `DATABASE_URL` present (never
   connected to).
4. **`scripts/package.json`** — `oidc:check-scope-enforcement-coverage`,
   `oidc:test-route-scope-wiring`.
5. **`.github/workflows/security.yml`** — two new steps, next to the OIDC
   suite; the dynamic step sets a dummy `DATABASE_URL`.

## Behavior change (deliberate)

A token without `openid` now gets `403 insufficient_scope` +
`WWW-Authenticate: Bearer error="insufficient_scope", scope="openid"` from
`/oidc/userinfo` instead of claims. All other failures keep their previous
status and challenge shape. Every seeded first-party client requests
`openid profile email`, so no current client is affected.

## Deviation from the roadmap text

The roadmap suggests extending the Phase F4 validator to flag registry entries
missing scope middleware. That isn't possible today: `ENDPOINT_REGISTRY` is
generated from routes mounted via `routes/index.ts` under `/api`, and every
bare-origin `/oidc/*` router is mounted in `app.ts`, so none of them are in
the registry at all. A standalone check (item 2) is the same narrow,
purpose-built shape `check-ownership-gate-coverage.ts` uses. Folding this into
F1/F4 is future work once F1 models bare-origin bearer routes.

## Verification actually performed

- Static check: **passes** on the fixed tree; run against the *original*
  `oidc-userinfo.ts` it **fails with both violations** (direct import, no
  `requireOidcScope(` on `GET /oidc/userinfo`).
- The wiring test's structural marker (`"insufficient_scope"` in the closure
  `requireOidcScope()` returns, arity 3) was confirmed by transpiling the real
  factory; the marker is **not** present in `userinfoHandler`'s own body, so
  the test can't pass for the wrong reason.
- Syntax diagnostics clean on all changed/new TS files.

## Not verified

- `test-route-oidc-scope-wiring.ts` was **not executed**: this checkout has no
  `node_modules`, and importing the real routers needs the workspace installed.
  Run `DATABASE_URL=postgres://test:test@localhost:5432/test pnpm --filter @workspace/scripts oidc:test-route-scope-wiring` once.
- No live HTTP round trip against `/oidc/userinfo`.
- `evaluateScopeCreep()` (7e) call sites are still confirmed by hand only
  (`oidc-authorize.ts`, `oidc-consent.ts`), as the coverage script's header says.

## Files touched
- `artifacts/api-server/src/routes/oidc-userinfo.ts`
- `scripts/src/check-oidc-scope-enforcement-coverage.ts` (new)
- `scripts/src/test-route-oidc-scope-wiring.ts` (new)
- `scripts/package.json`
- `.github/workflows/security.yml`
