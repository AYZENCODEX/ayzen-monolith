# AYZEN — Event & Workflow Enforcement Roadmap (Season 2, Track H), Phase H12.1: Legacy Bridge or Retirement Decision

## Scope, as roadmapped

`AYZEN_H4_Event_Workflow_Enforcement_Roadmap_Season2.md`'s H12.1, closing
Season 1 finding #8: the legacy monolith event-bus
(`artifacts/api-server/src/lib/event-bus`) and the new
`@ayzen/events`/`@ayzen/event-client` system are two disconnected islands;
`identity` only proxies HTTP to the monolith and never publishes anything
itself despite declaring `emittedEvents`. The roadmap asks for a decision —
bridge the two buses, or set a concrete cutover date — verified by either a
working bridge demo or a dated cutover plan with the remaining proxy
services listed.

**Decision: dated cutover, not a bridge.** Reasoning below; the remaining
proxy-service list this phase's verification asks for is exactly one
entry: `identity`.

---

## Investigation

### 1. `identity` is the only remaining proxy service

`services/README.md` states the general rule this repo already operates
under: *"The gateway keeps all routes on the compatibility monolith until
an extracted service URL is explicitly configured."* Every other service
under `services/*` (`finance`, `mail`, `vault`, `notification`, `workflow`,
`search`, `ai`, `marketplace`, `intelligence`, `admin`) owns real logic and
publishes for itself once extracted (H5–H11 treat every one of them as a
real, independent publisher). A repo-wide search for the monolith-proxy
pattern (`MONOLITH_URL`/`IDENTITY_BACKEND_URL`-style fallback plus a raw
`fetch()` relay) turns up exactly one service built that way:
`services/identity/src/index.mjs` — every request is forwarded verbatim to
the monolith and the response relayed back, with no business logic and no
event publishing anywhere in the file.

### 2. `identity` has no owned logic to natively emit events *from* yet

The deeper reason a bridge doesn't fit `identity` specifically: unlike
`finance`/`mail`/`vault`/etc., `identity` isn't a real service with an
unbridged event — it's a network hop with no state of its own.
`packages/domain-boundaries`'s domain contract already declares `identity`
as the target-state owner of `users`, `credentials`, `sessions`, `mfa`,
`oidc_clients` (and `DATABASE_OWNERSHIP.identity` names the specific tables
it's meant to own), but none of that data access exists in
`services/identity` today — every read and write still happens inside the
monolith's own auth routes. A bridge translates an event a service already
produces into the other bus's shape; there is no `identity`-produced event
to translate, because `identity` doesn't yet do the writes that would
produce one.

Notably, the domain logic to make those writes largely already exists as
its own, fully self-contained package — `packages/identity`
(`@ayzen/identity`)'s `createHybridIdentityRegistry` implements local/AYZEN
account creation, linking, and session lifecycle end-to-end, with its own
internal event vocabulary (`IDENTITY_EVENT_TYPES`: `identity.local.created`,
`identity.session.created`, `identity.session.revoked`, etc.). It is wired
into exactly one caller in the whole repo — `scripts/validate-hybrid-identity-1-15.mjs`
— and not into `services/identity`, not into the monolith, and not onto
either event bus. This is a second, smaller disconnected island sitting
*underneath* the one H12.1 was asked to resolve, and it's the reason
`identity`'s cutover is a real-logic migration, not a wiring task: the
domain code exists, but nothing runs it.

(One reassuring finding on this front: `@ayzen/events`'s registry already
carries `user.created`, `user.updated`, `session.created`,
`session.revoked`, and `authentication.failed` as real, owned-by-`identity`
entries — see `packages/events/src/index.mjs`. The new bus is already
waiting for exactly the five types `identity`'s domain contract declares;
whichever code ends up producing them does not need a translation layer to
reach it, just a real `@ayzen/event-client` publisher call, the same
pattern `finance`/`mail`/`vault` already use per H5.3.)

### 3. A blind type-name bridge is unsafe, not just unnecessary

Even setting `identity` aside, a bridge built by subscribing broadly on the
monolith bus and forwarding by event-type name onto the new bus (or vice
versa) is not a safe default for the *other* ~35 event types that happen to
share a name across both registries. The two registries independently
accumulated heavy name overlap — `finance.transaction.created`,
`vault.secret.accessed`/`vault.secret.updated`, `wisp.message.received`/
`wisp.message.sent`, `notification.sent`/`notification.failed`,
`workflow.*`, `organization.member.*`, `telegram.*`, `policy.decision.*` all
exist as registered types on *both* `artifacts/api-server/src/lib/event-bus/event-registry.ts`'s
`DEFAULT_EVENT_TYPES` and `packages/events/src/index.mjs`'s `EVENT_TYPES` —
but the two envelopes are different shapes (`id`/`type` vs `eventId`/
`eventType`, no `organizationId`/`workspaceId` on the legacy envelope,
different `actor` shape), and neither registry's schema for a given name is
guaranteed to describe the same payload as the other's. For any domain that
has already been extracted (`finance`, `mail`, `vault`, `notification`,
`workflow`, ...), the gateway's per-request routing (`apps/api-gateway/src/routing.mjs`)
already sends all live traffic to the new service exclusively once its
`*_SERVICE_URL` is configured — the monolith's own registrations for that
domain's events go stale from that point on, by design. Bridging same-named
types back and forth between two live producers with independently-evolved
payload shapes would reintroduce exactly the kind of duplicate/malformed
delivery the H5–H11 phases spent their effort eliminating, for a set of
domains that don't need it (they're already fully cut over) — and for
`identity`, which isn't cut over at all, there's nothing yet to bridge (see
§2). Neither side of the roadmap's "bridge" option has a safe, real target
in this codebase today.

---

## Decision

Set a cutover date for `identity` rather than build a bridge. `identity` is
confirmed as the only remaining monolith-proxied service, so this is a
single, scoped migration, not an open-ended list.

### Cutover date

**Target: end of Season 3** (this repo's roadmap numbering — the next
season after the OIDC roadmap referenced throughout `artifacts/api-server/src/lib/oidc-*`
completes its own Sylo cutover). Concretely, this phase sets the date at
**90 days from this decision** and follows the same operator-flip
convention already established for exactly this kind of migration
(`lib/oidc-client-rollout.ts`'s rollout-flag pattern: fail-safe to the old
path on any doubt, one flag, cache-invalidate on write, admin + CLI both
able to flip it).

### Phased plan

| Step | What | Owner | Gate |
|---|---|---|---|
| 1 | Stand up `identity`'s own data store for `users`/`credentials`/`sessions`/`mfa`/`oidc_clients` (the tables `DATABASE_OWNERSHIP.identity` already declares) — dual-write alongside the monolith's existing tables, monolith remains source of truth | Identity | N/A — additive only |
| 2 | Wire `packages/identity`'s `createHybridIdentityRegistry` (or a Postgres-backed equivalent using the same shape) into `services/identity`'s actual auth routes, behind a rollout flag defaulting OFF | Identity | Flag off by default; monolith stays authoritative |
| 3 | Once step 2's dual-write has run long enough to diff clean against the monolith, flip `services/identity` to `@ayzen/event-client`-publish `user.created`/`user.updated`/`session.created`/`session.revoked`/`authentication.failed` natively on every write (no translation needed — see §2's note that `@ayzen/events` already owns these five names) | Identity | Rollout flag; same fail-safe-to-old-path posture as `lib/oidc-client-rollout.ts` |
| 4 | Flip `identity` to be the system of record; monolith's own identity-adjacent routes (`routes/auth.ts`, session/OIDC routes) stop being called directly, same "disable and return to monolith" rollback `services/identity`'s `rollbackStrategy` field already documents, in reverse | Identity | Read/write traffic fully on `identity`'s own store for one full deploy cycle with no rollback |
| 5 | Remove the HTTP-proxy code path in `services/identity/src/index.mjs` entirely | Identity | Step 4 complete |

Steps 1–2 are additive/observational and can start immediately without
risk to the live auth path. Steps 3–5 are the actual cutover and are each
independently gated and reversible, matching the roadmap's own "each item
closeable independently" convention.

### Remaining proxy services (verification list)

Exactly one: **`identity`** (`services/identity/src/index.mjs`). No other
service under `services/*` proxies to the monolith for its primary logic.

---

## What ships in this phase

Building steps 1–5 above is its own multi-season migration and out of
H12.1's scope (H12.1 is the *decision*, per the roadmap's own framing — see
the precedent `docs/changes/CHANGES_OIDC_LOGOUT_PROPAGATION_DECISION_PHASE6D.md`
sets for a decision-only sub-phase landing with no broad implementation).
What this phase does close out now, because it was a direct, low-risk
consequence of the investigation above:

**`services/identity`'s `emittedEvents` declaration was inaccurate.** It
listed all five target events as if the running service already emitted
them (`packages/service-runtime`'s `createServiceServer` surfaces this
list verbatim on `GET /internal/manifest` and `GET /health` — see
`packages/service-runtime/src/index.mjs`'s `manifest` object — so this
wasn't inert metadata, it was a runtime claim an operator or a future
tooling consumer could reasonably trust). Since `identity` doesn't publish
anything (§1/§2 above), the declaration is now `[]`, with a comment
pointing at this document and at `packages/domain-boundaries`'s entry for
`identity`, which is left unchanged — that one is the intentional
target-state domain contract, not a claim about what's live today, and
should not be "corrected" to match the proxy's current behavior.

### Verification

`GET /internal/manifest` on a running `identity` service now reports
`emittedEvents: []`, matching what the service actually does (nothing) —
previously it reported five event types with no code path anywhere that
ever published any of them.
