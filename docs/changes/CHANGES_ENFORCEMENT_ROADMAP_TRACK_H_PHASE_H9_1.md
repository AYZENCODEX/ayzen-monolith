# AYZEN Enforcement Roadmap — Track H, Phase H9.1 (fine-grained authorization gate)

**Roadmap:** `AYZEN_H4_Event_Workflow_Enforcement_Roadmap_Season2.md`, Phase
H9, item H9.1 only. H9.2 (the `CAPABILITY_AUTHZ_GATE` kill switch) is not
part of this pass — see "Not done" below.

## H9.1 — a real scope/step-up check, not just identity presence

`@ayzen/authorization`'s `authorizeServiceCapability()` — the one gate every
extracted service goes through via `@ayzen/service-runtime`'s
`createServiceServer` (Phase H4) — only ever proved a gated route had *some*
authenticated caller behind it. Its own header already said so plainly: it
stops at `IDENTITY_PRESENT_SCOPE_NOT_VERIFIED` and never calls the
fine-grained `authorizeCapability()` that scope/role/step-up logic actually
lives in (the same function `packages/workflow/src/executor.mjs`'s
step-boundary gate already uses, H8.3). Season 1 finding #6.

`packages/service-runtime/src/index.mjs` now runs a second stage right
after the existing coarse gate, inside the same `if (gateMode !== "off")`
block:

- Skipped entirely for a route the coarse gate already resolved as
  `NO_SCOPE_REQUIRED` (no scope, not sensitive — nothing further to check)
  or `INTERNAL_SERVICE_TRUSTED` (an already-verified service-to-service
  caller — re-deriving a scope decision for it from nothing would be
  strictly less trustworthy, not more, per `authorizeServiceCapability`'s
  own header).
- Otherwise calls `authorizeCapability()` with the caller's real
  `subject`/`scopes`/`roles`/`stepUpAt`, normalized from whatever shape
  `authenticate()` produced (a raw verified-JWT payload — `sub`, not
  `subject` — from `createJwksAuthenticator`, or a `createServiceIdentity()`
  object, which already uses `subject`) by a new `capabilityAuthContext()`
  helper — the same normalization `services/workflow/src/index.mjs`'s
  `actorFrom()` already does for the same reason (H8.3/H8.4).
- A `MISSING_SCOPE` decision denies with `403`; `STEP_UP_REQUIRED` denies
  with `428` (matching `services/ai/src/index.mjs`'s existing convention
  for the same case); `AUTHENTICATED_SUBJECT_REQUIRED` (defensive — should
  not be reachable given the coarse gate already required an identified
  caller) denies with `401`. Every denial is logged the same way the
  coarse gate's own denials are (`policy.decision.denied`, tagged
  `stage: "capability_authz"` to distinguish the two gates in logs).

**Verification:** `packages/service-runtime/test/capability-gate.test.mjs`
(new) boots a real HTTP server via `createServiceServer` — no gate mocking —
and drives it with real requests against real routes from
`@ayzen/capabilities`' registry: `finance.list-accounts` (scope
`finance:read`, not sensitive) and `finance.post-transaction` (scope
`finance:write`, sensitive). Covers: missing scope denied (403); scope
present succeeds; sensitive capability without a recent step-up denied
(428); with step-up succeeds; an internal service-to-service caller bypasses
the fine-grained check entirely; `SERVICE_CAPABILITY_GATE=report` logs but
doesn't block; `SERVICE_CAPABILITY_GATE=off` skips both stages; no auth at
all is still caught by the coarse gate before the fine-grained gate ever
runs. All 8 cases pass, plus the full existing suite (packages/workflow
27/27, apps/worker 17/17, and every other package with tests) re-run clean
with no regressions.

## Not done (by design — this is H9.1 only)

**H9.2's dedicated kill switch.** This gate currently shares `gateMode`
(`SERVICE_CAPABILITY_GATE`) with the coarse gate rather than getting its own
`CAPABILITY_AUTHZ_GATE`, exactly as the roadmap's own phase split implies —
H9.2 is a separate line item. This matters more here than it did for the
coarse gate: `SERVICE_CAPABILITY_GATE` defaulting to `"enforce"` was safe
because every real caller already satisfied its only requirement (being
authenticated at all). This new stage requires real `scopes`/`roles`/
`stepUpAt` claims on the caller's token — and nothing in this repo currently
mints an internal JWT (via `createJwksAuthenticator`'s issuer) that
populates those claims for a real user session. **Flip
`SERVICE_CAPABILITY_GATE` to `"enforce"` (its default) against real traffic
before H9.2 ships its own independently-toggleable switch, and every
request to a scoped or sensitive capability will be denied**, not just the
ones that should be. H9.2 should land before this is turned on anywhere but
a test/staging environment with `SERVICE_CAPABILITY_GATE=report` (or `off`).
