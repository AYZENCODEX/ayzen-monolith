# AK4 Roadmap, Phase 2: Event Wiring — Five Baselined Findings, Decided

## Scope, as roadmapped

`AK4_ROADMAP.md`'s Phase 2 covers five findings frozen in
`scripts/event-wiring-baseline.json`, each verified real against actual
route/handler code, not just a declaration mismatch. The roadmap asks for
a product decision on each — matching this repo's own H12.1 precedent
(`CHANGES_H4_EVENT_WORKFLOW_ENFORCEMENT_PHASE_H12_1.md`) for this exact
class of gap: an inaccurate `emittedEvents`/`consumedEvents` declaration is
a runtime claim (`GET /internal/manifest`), not inert metadata, and fixing
it is a decision about what the service actually does, not a wiring
patch.

**Decisions below, in the roadmap's stated priority order:**

| Finding | Decision |
|---|---|
| 2a `wisp.message.received` | **Build** the inbound path |
| 2b `mail.delivery.updated` | **Correct** today's declaration; leave the underlying feature decision open |
| 2c `finance.transaction.updated` | **Correct** the declaration, target-state included |
| 2d `alert.created` (admin) | **Correct** the declaration |
| 2e `incident.created` (admin) | **Correct** the declaration |

---

## 2a. `wisp.message.received` — build

### Investigation

Re-confirmed by hand, not just via the frozen baseline: `notification` and
`workflow` both declare this in `consumedEvents`, and `apps/worker`'s
dispatch table has real, working `registry.register("wisp.message.received", ...)`
entries for both (with test coverage in
`apps/worker/src/consumers.test.mjs`). `services/mail` had only outbound
`POST /api/mail/messages` (publishing `wisp.message.sent` +
`mail.delivery.requested`) — no inbound-receive route existed anywhere.

This is the one finding of the five where deleting instead of building
would have thrown away real, tested downstream code. The other four have
no consumer depending on them; this one does, on two consumers, with
tests. That asymmetry is why the roadmap flagged it "highest priority" and
it's also why it's the one finding this phase builds rather than corrects.

### Decision: build

Added `POST /api/mail/messages/receive` to `services/mail` — an inbound
webhook target for an external mail provider (inbound-parse / IMAP-bridge
style). See `services/mail/src/inbound.mjs` and the wiring in
`services/mail/src/index.mjs`.

Key design points, each because this is a genuinely different trust
boundary from every other route in this service:

- **Authentication is a shared secret, not the AYZEN JWT/service-signature
  scheme** (`createConfiguredAuthenticator`) every other route uses. An
  external mail provider has no AYZEN identity to present. The route
  checks `MAIL_INBOUND_WEBHOOK_SECRET` against an `x-ayzen-mail-webhook-secret`
  header in constant time (`crypto.timingSafeEqual`, the same posture
  `@ayzen/auth-client`'s `verifyServiceSignature` already uses for its own
  comparison).
- **Fails closed.** No configured secret means the route refuses
  everything (`503 MAIL_INBOUND_WEBHOOK_NOT_CONFIGURED`) rather than
  accepting unauthenticated inbound mail — the same "missing required
  config is a boot/request-time error, not a silent gap" posture this
  service already uses for `DATABASE_URL` (H6.2).
- **Deliberately not registered in `@ayzen/capabilities`' `CAPABILITY_REGISTRY`.**
  That registry models AYZEN-scoped user/service actions with scopes; this
  route has neither a user nor an internal service on the other end.
  Registering it there would imply it goes through the standard
  scope-based authz model, which doesn't fit a webhook and would be
  actively misleading about how the route is actually secured.
- **Idempotent on the provider's own message id.** Providers retry
  webhook delivery on anything short of a 2xx; the route requires
  `providerMessageId` in the payload and keys the existing Postgres-backed
  idempotency store on it (scope `mail-inbound`), so a retried delivery is
  a no-op instead of a duplicate inbound message.
- **Publishes `wisp.message.received`** with `{ messageId, threadId,
  mailbox, from, recipientCount }` — `mailbox` matches what
  `apps/worker`'s existing `notification` dispatch entry already reads
  (`event.payload?.recipient ?? event.payload?.mailbox`), so the existing
  consumer wiring picks it up with no changes on that side.

Unit tests: `services/mail/src/inbound.test.mjs` (webhook-secret
verification, payload validation, message construction).

### What this decision does not cover

The webhook payload shape here is a reasonable inbound-parse-style
contract (`mailbox`, `from`, `subject`, `body`, `providerMessageId`,
optional `threadId`), but no real provider has been chosen, so no
provider-specific parsing (MIME, attachments, SPF/DKIM headers) is
implemented — the route accepts an already-normalized JSON payload. Which
provider to integrate, and whether provider-specific verification (e.g. a
provider's own signature scheme, in addition to or instead of the shared
secret) is needed, is a separate, real integration decision this phase
does not make.

---

## 2b. `mail.delivery.updated` — correct

### Investigation

Confirmed no producer (`grep` for `publish(...)` calls anywhere in
`services/mail/src/**` — zero) and, unlike 2a, **also no consumer**:
nothing in any service's `consumedEvents`, no `apps/worker` dispatch
entry, no test referencing the type. This is a pure orphan declaration —
nothing anywhere depends on it existing, so correcting it (unlike 2a)
carries no dead-pipeline risk on the other side.

### Decision: correct today's declaration; leave the feature question open

Removed `mail.delivery.updated` from `services/mail`'s `emittedEvents`
(the runtime manifest — what `GET /internal/manifest` actually claims
today). **Left `packages/domain-boundaries`' mail contract and
`packages/events`' central registry unchanged** — following the H12.1
precedent exactly: domain-boundaries is the intentional target-state
contract, not a claim about what's live today, and a delivery-status
mechanism (provider webhook vs. poll) is a plausible real future feature
with no evidence either way against it, unlike 2c below.

**Still open, and explicitly not decided here:** whether to build a real
delivery-status-update mechanism, and if so what triggers it (a provider
webhook, similar to 2a's inbound route, or a poll). Flagging this as a
separate, later scope decision rather than bundling a second webhook
integration into this pass.

---

## 2c. `finance.transaction.updated` — correct, target-state included

### Investigation

Confirmed `services/finance` has only `GET`/`POST /api/finance/accounts`
and `POST .../transactions` — no `PATCH`/`PUT` anywhere. Also confirmed,
re-reading the service's own manifest: its `rollbackStrategy` already
reads `"disable FINANCE_SERVICE_URL; never reverse committed ledger
entries"` — explicit, pre-existing design intent that this is an
append-only ledger. Real double-entry accounting systems correct mistakes
via a new reversing/adjusting transaction, not by mutating a posted one;
this service's own rollback policy already commits to that model.

This is a different situation from 2b: there the target-state question is
genuinely open; here the service's own code already answers it. Treating
`finance.transaction.updated` as "not yet built" would be describing an
event this architecture was never going to emit.

### Decision: correct the declaration, in both places

Removed `finance.transaction.updated` from `services/finance`'s
`emittedEvents` (runtime manifest) **and** from `packages/domain-boundaries`'
finance contract (target-state) — the only one of 2b/2c/2d/2e where the
domain-boundaries entry is also corrected, because here (unlike 2b) the
in-repo evidence bears directly on the target state, not just today's
implementation. `packages/events`' central registry keeps the type
(`finance.transaction.updated` stays a valid, versioned event
definition) since removing a type from that shared catalog is a
higher-blast-radius change than this phase's scope, and nothing requires
it — no service claims to emit or consume it now.

---

## 2d / 2e. `alert.created` / `incident.created` (admin) — correct

### Investigation

Confirmed `packages/alerting` has a full alert store (create/list/dedupe)
but is wired into exactly one caller in the whole repo —
`services/intelligence` — which uses it as a **local, file-backed**
orchestrator (`intelligence-alerts.json`) for its own security-signal
routing. It never calls `.publish()` onto the event bus; `intelligence`
doesn't even declare `alert.created` in its own `emittedEvents`. So
`packages/alerting` is not, today, connected to the `alert.created` /
`incident.created` types admin declares at all.

`services/admin` only **ingests** these two types, externally pushed via
`POST /api/admin/events` (confirmed at the line handling
`event.eventType === "alert.created" || event.eventType === "incident.created"`)
— it never produces them.

Two further pieces of in-repo evidence, beyond the missing `publish(...)`
call:

- `packages/events`' central registry names **different owners** for both
  types — `alert.created` → `owner: "alerting"`, `incident.created` →
  `owner: "incident"` — neither is `"admin"`.
- `packages/domain-boundaries`' admin contract listed both types in
  **both** `consumedEvents` and `emittedEvents`, identically. Admin
  consuming its own emitted event makes no sense as a deliberate design;
  the shape is a copy-paste artifact, not an intentional "admin is also
  the producer" decision.

Separately, `apps/worker`'s H11.2 lag/stall monitors (`event.consumer.lag`,
`workflow.stalled`) already establish this repo's real precedent for how
an alert-like condition gets onto the bus: **the process that detects the
condition publishes directly**, not routed through a central admin
publisher. That comment block explicitly frames the published event as "a
real, consumable event like any other" that `admin`, `intelligence`, or a
dashboard can subscribe to — i.e., admin is modeled as a *consumer* of
alerts in this repo's own established pattern, consistent with what its
code actually does.

### Decision: correct the declaration

Removed `alert.created` and `incident.created` from `services/admin`'s
`emittedEvents` (runtime manifest) and from `packages/domain-boundaries`'
admin contract's `emittedEvents` (the duplicate-list artifact) — in both
places, `consumedEvents` is untouched and correct as-is.

**Still open, and explicitly not decided here:** whether
`packages/alerting` should be wired as a real bus producer somewhere (fed
by, e.g., the H11.2 monitors rerouted through it, or `intelligence`'s
existing local orchestrator publishing onto the bus in addition to its
file store), or whether some other component altogether should own
`incident.created` (the registry's `owner: "incident"` doesn't correspond
to any existing service name in this repo — worth a separate look, but
out of scope for a declaration correction).

---

## What ships in this phase

- `services/mail/src/inbound.mjs` (new) + `inbound.test.mjs` (new): the
  2a inbound-mail webhook.
- `services/mail/src/index.mjs`: wires the new route in; `emittedEvents`
  drops `mail.delivery.updated` (2b).
- `services/finance/src/index.mjs`: `emittedEvents` drops
  `finance.transaction.updated` (2c).
- `services/admin/src/index.mjs`: `emittedEvents` drops `alert.created`,
  `incident.created` (2d/2e).
- `packages/domain-boundaries/src/index.mjs`: finance contract drops
  `finance.transaction.updated` (2c, target-state); admin contract drops
  the same two types from `emittedEvents` only (2d/2e). Mail's contract
  is deliberately left unchanged (2b).
- `scripts/event-wiring-baseline.json`: regenerated via
  `node scripts/validate-event-wiring.mjs --update-baseline` — now `[]`.
  All five findings this phase started with are resolved; none remain
  frozen.

### Explicitly out of scope, noticed but not touched

`infrastructure/platform/domain-contract-registry.json`,
`infra/event-catalog/catalog.json`, and `config/circuit/platform-circuit.json`
also carry static copies of `finance.transaction.updated`,
`mail.delivery.updated`, `alert.created`, and `incident.created`. These
are read only by an older "roadmap 1-50" milestone-tracking validator
suite (`scripts/validate-roadmap-1-50.mjs` and siblings), which checks
them for internal self-consistency against each other and against source
markers, not against `packages/domain-boundaries`'s live contracts. They
predate and are separate from the Track H / AK4 event-wiring enforcement
this phase is part of. Left unchanged rather than edited without the
ability to run their validator (see Verification below).

### Verification

```
$ node scripts/validate-event-wiring.mjs
{
  "status": "passed",
  "totalFindings": 0,
  "baselineSize": 0
}

$ node --test services/mail/src/inbound.test.mjs
# tests 9
# pass 9
# fail 0
```

**Not run, and not able to be run in this environment:** `pnpm typecheck`,
`node scripts/validate-domain-contract-coverage.mjs`, and the legacy
`validate-roadmap-*`/`validate-track-a-d`/`validate-api-security-backbone-*`
scripts — all of them import workspace packages (`@ayzen/*`), and this
environment has no network access to `pnpm install` them (the same
constraint AK4 Phase 4a/4b already documents for H14's own changes). This
is a real gap: `validate-domain-contract-coverage.mjs` in particular
cross-checks `packages/domain-boundaries`' `publicOperations` against
`@ayzen/endpoint-registry`, and this phase edits that same file. Before
trusting these Phase 2 changes in CI, run that validator (and the others
above) somewhere with `pnpm install` available, the same follow-up AK4
Phase 4 already calls for on H14's changes.
