# AYZEN Enforcement Roadmap — Track H (Policy / Ownership Enforcement), Phase H4

**Roadmap:** `AYZEN_EventBus_Workflow_Enforcement_Roadmap.md`, Phase H4 —
"extend policy coverage to the extracted services and Telegram adapters ...
make sure every domain adapter and every extracted-service route also goes
through the same policy engine — not a second, separately-maintained
authorization path per surface."

## Finding #1: Telegram already satisfies H4 — verified, not fixed

Read `artifacts/api-server/src/lib/telegram-command-adapter.ts` end to end.
A Telegram command does not evaluate any authorization itself: it resolves
the command to a capability (`@ayzen/capabilities`), mints a short-lived
(60s) bearer token for the linked account, and issues a real HTTP request
to the monolith's own route (`fetchImpl(...)`) with that token. The
response is relayed back verbatim. So every Telegram command already goes
through whatever `PolicyEngine`/ownership gate the target HTTP route has —
the same one an ordinary API caller hits. There is no second authorization
path here to unify; this half of H4 required a read, not a change.

## Finding #2: the extracted services have no shared authorization path at all

`services/*/src/index.mjs` (finance, vault, mail, notification, workflow,
ai, marketplace, search, identity, intelligence, admin) each call
`createConfiguredAuthenticator()` for **authentication** only. Past that,
authorization was either a hand-rolled inline check (finance.mjs's
`if (account.workspaceId && tenant.workspaceId && ...)` tenant comparison)
or nothing. Separately, `packages/authorization/src/index.mjs` already
declared a `CAPABILITY_POLICIES` map — scopes + a `sensitive` flag per
capability — but `grep -rl "authorizeCapability\|@ayzen/authorization"`
across the repo found exactly one consumer, `scripts/validate-phase-1-11.mjs`.
It was dead code: a second, hand-maintained table of the same ~40
capabilities `@ayzen/capabilities`'s `CAPABILITY_REGISTRY` already lists,
never imported by anything that makes a real decision. This — not a
missing feature so much as an already-written, never-wired one — is the
"second, separately-maintained authorization path" the roadmap's own
wording describes.

Also relevant: `artifacts/api-server/src/lib/migration-registry.ts`'s
`MIGRATION_ROUTES` are all still in cutover state `"monolith"` — no
extracted service receives live traffic yet. This phase closes the gap
before it is reachable, not an active hole.

## What changed

1. **`packages/capabilities/src/index.mjs`** — added a `sensitive: boolean`
   8th column to every `CAPABILITY_REGISTRY` definition (copied 1:1 from
   the values `packages/authorization`'s old `CAPABILITY_POLICIES` already
   had, entry by entry — no behavior invented, only relocated) and a new
   `matchCapabilityRoute(method, pathname)` export: matches a raw
   `(method, path)` pair — what an extracted service's own HTTP handler
   sees — against the same route templates already used to resolve
   Telegram commands, via a per-entry `RegExp` built once at module load.
   Returns the matched `CAPABILITY_REGISTRY` entry, or `undefined` for an
   unregistered path (health checks, `/internal/*`) — deliberately
   distinct from a denial.
2. **`packages/authorization/src/index.mjs`** — `CAPABILITY_POLICIES` is
   now `derived` from `@ayzen/capabilities`'s `CAPABILITY_REGISTRY`
   (`entry.permission` → `scopes`, `entry.sensitive` → `sensitive`)
   instead of hand-duplicating it. `authorizeCapability()` and every other
   existing export keep their exact prior signatures/behavior — verified
   by re-running `scripts/validate-phase-1-11.mjs` unchanged (still green,
   still reports "41 capabilities").
   New export, **`authorizeServiceCapability({ method, pathname, auth,
   internalService })`** — the function `service-runtime` calls on every
   extracted-service request:
   - No capability matches the route → `{ decision: "not_gated" }`
     (health/internal endpoints; caller proceeds as before).
   - `internalService: true` (an already-verified service-to-service
     caller, see below) → always `allow` — it was already gated upstream.
   - Capability requires no scope and isn't sensitive → `allow`.
   - No identity at all (`auth.subject`/`auth.sub`/`auth.userId` all
     absent — real AYZEN session JWTs, `lib/jwt.ts`'s `signAuthToken`,
     carry `{userId, role}`, not a `sub`/`subject` claim, so all three are
     checked) → `deny`, reason `AUTHENTICATED_SUBJECT_REQUIRED`.
   - Identity present → `allow`, reason `IDENTITY_PRESENT_SCOPE_NOT_VERIFIED`
     — labeled honestly as a partial decision; see "Not done" below for why
     it stops there.
3. **`packages/service-runtime/src/index.mjs`** — `createServiceServer`'s
   request handler now calls `authorizeServiceCapability()` once, right
   after `authenticate()` and before `handle()`, for every one of the ~10
   extracted services (one call site, not one edit per service). A
   `not_gated` result is silent (no log, no behavior change). Every other
   result is logged as a structured `policy.decision.allowed` /
   `policy.decision.denied` record — same event-name convention Phase H3
   used for the monolith's audit stream, now present for this surface for
   the first time. A `deny` result blocks the request with `401` and
   `{code: "AUTHENTICATED_SUBJECT_REQUIRED", capability, requestId}`
   **only** when `SERVICE_CAPABILITY_GATE` (env var) is unset or `enforce`
   (the default). `report` logs the identical decision but never blocks
   (safe rollout / staging observation); `off` skips the gate entirely.
   An unset or typo'd value falls back to `enforce` — same "fail toward
   the safe option" rule Phase H3's `POLICY_DECISION_EVENTS` kill switch
   used, deliberately inverted here since "safe" for a gate means
   fail-closed, not fail-open.
   `auth?.actorType === "service"` (the existing
   `verifyServiceRequestHeaders` internal-secret branch, already present
   in `createConfiguredAuthenticator`) is passed through as
   `internalService: true` — an internal gateway/service caller is trusted
   rather than re-decided from nothing, since it was already authorized
   wherever it was minted.
4. **`packages/authorization/package.json` / `packages/service-runtime/package.json`**
   — added the new `@ayzen/capabilities` / `@ayzen/authorization`
   workspace dependencies respectively. No circular dependency:
   `capabilities` → (nothing new) → `authorization` → `service-runtime`.
5. **`scripts/src/test-policy-service-capability-gate.ts`** (new) —
   auto-discovered by `run-verification-suite.mjs`'s `test-policy-*` glob,
   no change needed there. 11 tests, run directly with `tsx --test` against
   the real exports (not mocks): registry sanity (every entry has a
   `sensitive` boolean), the same-scope-different-sensitivity case
   (`identity.issue-session` vs. `identity.revoke-session`) that rules out
   deriving `sensitive` from the scope string, `authorizeCapability`'s two
   pre-existing `validate-phase-1-11.mjs` assertions re-pinned here as a
   regression guard, route matching (including a GET/POST route-shape
   collision on `/api/vault/:secretId/reveal`), and every
   `authorizeServiceCapability` branch (not-gated, anonymous-denied,
   identity-by-userId/sub, internal-trusted, empty-object-treated-as-absent).

## Kill switch

`SERVICE_CAPABILITY_GATE=enforce` (default) | `report` | `off` — see point 3
above.

## Deviation from a literal reading — and why

A literal "same policy engine" would mean the extracted services call the
actual DB-backed `PolicyEngine`/RBAC the monolith uses, and get an
identical ALLOW/DENY for identical input. I did not build that, and want to
be explicit about why rather than have it discovered later:

- `packages/service-runtime/src/index.mjs`'s own file header states it
  "deliberately contains no database client and no domain behavior" so
  extracted services "can be deployed independently without importing the
  legacy API server." Giving it a database client to run RBAC queries
  contradicts that design choice; I didn't make that call unilaterally.
- The alternative — a live call back into the monolith (a small internal
  PDP endpoint, `POST /internal/policy/authorize` or similar, reusing
  `lib/policy/pep/authorize.ts`'s real `authorize()`) — is architecturally
  the more faithful answer and the one I'd recommend for a Phase H4-B, but
  it surfaces a genuine, pre-existing gap that has to be resolved FIRST,
  not glossed over: AYZEN currently has **three independent permission
  vocabularies with no declared mapping between them** —
  `@ayzen/capabilities`'s capability names (`domain.operation`, e.g.
  `finance.post-transaction`), `@ayzen/authorization`'s OAuth-style scopes
  (`domain:action`, e.g. `finance:write`), and
  `lib/policy/rbac/permission-matcher.ts`'s RBAC permission keys
  (`product.resource.action`, e.g. `sylo.vault.read`). And AYZEN's session
  JWTs (`lib/jwt.ts`'s `signAuthToken`) carry only `{userId, role, sid}` —
  no scopes claim — so a scope-based decision can only be made by looking
  the user's actual grants up somewhere live (DB or PDP call), never from
  the bearer token alone.
- Inventing a capability→RBAC-permission-key mapping myself, un-reviewed,
  to make a PDP endpoint "work" risked silently over- or under-granting
  something sensitive (finance, vault) — worse than the gap this phase
  actually closes. I chose the smaller, honest, verifiably-correct slice
  (identity-required + audited + single source of truth for the
  capability/scope table) over a larger change I could not verify was
  right.

## Not done (deliberately, see above)

- **Scope-level enforcement at the extracted-service layer.**
  `authorizeServiceCapability()` currently answers "is someone
  authenticated on a route this registry says needs a scope" — not "does
  this specific user hold that specific scope." A user authenticated for
  ANY capability currently passes the gate for ALL of them. This is
  strictly better than today's baseline (zero shared check, silently
  allowed anonymous writes on misconfigured services) but is not yet
  parity with the monolith's real per-route ownership/ABAC gates from
  Tracks C/H1/H2.
- **The H4 gate criterion ("a capability denied at the HTTP route is also
  denied via the equivalent extracted-service call") is not yet fully
  met** for the reason above — it now holds for the *unauthenticated*
  case (denied both places) but not yet for an authenticated user who
  lacks the specific required scope.
- A **Phase H4-B** is the natural next step: (1) declare the
  capability↔RBAC-permission-key mapping explicitly and get it reviewed,
  (2) add scopes to `signAuthToken`'s payload (or a `POST
  /internal/policy/authorize` PDP endpoint services call instead), (3)
  upgrade `authorizeServiceCapability`'s `IDENTITY_PRESENT_SCOPE_NOT_VERIFIED`
  branch into a real scope check once (1)-(2) exist.

## Verification actually performed

- **11/11 tests pass** in `scripts/src/test-policy-service-capability-gate.ts`,
  run directly with `tsx --test` (temporary local `node_modules/@ayzen/*`
  symlinks to the workspace packages — this sandbox has no `pnpm`, same
  limitation Phase H3 noted; symlinks removed after testing, nothing
  committed).
- **`scripts/validate-phase-1-11.mjs` re-run unchanged and still passes**
  ("Phase 1–11 validation passed (11 evidence files, 41 capabilities)") —
  confirms the `CAPABILITY_POLICIES` refactor didn't change
  `authorizeCapability()`'s observable behavior for its one pre-existing
  consumer.
- `node --check` clean on all 3 changed/new `.mjs` files.
- Manual grep confirmed no other file imports `@ayzen/authorization`'s
  `CAPABILITY_POLICIES` internals directly (only the public functions),
  and no circular import between `capabilities` → `authorization` →
  `service-runtime`.

## Not verified

- No way to start the actual HTTP servers in this sandbox (no live
  Postgres/Redis, no `pnpm install`), so the end-to-end `401` response
  `createServiceServer` returns for a denied request — and the
  `SERVICE_CAPABILITY_GATE=report`/`off` kill-switch behavior — were
  verified by direct reading of the modified handler, not by an actual
  HTTP round trip. `authorizeServiceCapability()` itself, which is the
  function that makes the decision, IS unit-tested directly (see above).
- Not load-tested: the gate adds one synchronous function call per
  request (no I/O, no DB, no network) so the cost should be negligible,
  but this wasn't measured.
- The Phase H4-B prerequisite work described above (capability↔RBAC
  mapping, JWT scopes claim or a PDP endpoint) was not started.

## Files touched
- `packages/capabilities/src/index.mjs`
- `packages/authorization/src/index.mjs`
- `packages/authorization/package.json`
- `packages/service-runtime/src/index.mjs`
- `packages/service-runtime/package.json`
- `scripts/src/test-policy-service-capability-gate.ts` (new)
