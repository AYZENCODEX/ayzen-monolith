# AYZEN Enforcement Roadmap — Track H (Policy / Ownership Enforcement), Phase H3

**Roadmap:** `AYZEN_EventBus_Workflow_Enforcement_Roadmap.md`, Phase H3 —
"tie policy decisions into the EventBus".

## Finding: the event types existed everywhere except as a producer

`policy.decision.allowed` / `policy.decision.denied` were:
- **Declared** — `packages/domain-boundaries`'s policy `emittedEvents`,
  `lib/event-bus/event-registry.ts`'s default registry,
  `infra/event-catalog/catalog.json`.
- **Consumed** — `lib/acie/index.ts` (`acie-collector:*`) and
  `lib/mega-engine/audit-integration.ts` (`mega-engine-audit`, denied only)
  both `subscribe()` to them.
- **Never published.** No call site anywhere published either type. Both
  subscribers were dead code, and the "auditable, replayable decision stream"
  the roadmap describes existed only in `authorization_audit_log` (Phase 17)
  — a local table, not a bus event other services can subscribe to or replay.

## What changed

1. **`lib/policy/events/decision-event-observer.ts`** (new, DB-free, same
   discipline as `lib/policy/decision-observer.ts` / `audit-observer.ts`) —
   `createPolicyDecisionEventObserver(publish, options)` builds a
   `PolicyDecisionObserver`. `ALLOW` → `policy.decision.allowed`; every other
   effect (`DENY`/`STEP_UP`/`APPROVAL_REQUIRED`) → `policy.decision.denied`,
   with the exact effect kept in `payload.effect`. The payload is built via
   `toAuditEntry()` — the one function that decides what's safe to persist —
   so this stream can never carry more than the audit table already does (no
   IP, session id, `context.extra`, scopes, or resource attributes beyond
   type+id). `decisionId` is deliberately **not** copied (it's freshly
   random per call); join on `requestId` instead. Publisher failures
   (sync throw or rejected promise) are swallowed and reported via
   `onError`, never surfaced to the request being authorized — same contract
   every other observer in this codebase follows.
   Exported via `lib/policy/events/index.ts` and re-exported from
   `lib/policy/index.ts`.
2. **`lib/policy-decision-events.ts`** (new, app-level — the only file here
   allowed to touch `@workspace/db`) — registers both event types with a real
   zod schema (previously schema-less in the default registry) and publishes
   through `publishEventStandalone` (the transactional outbox). Exports
   `policyDecisionEventObserver`, the ready-to-compose observer. Publish
   failures are logged, throttled to once/minute with a running count, so a
   DB outage doesn't spam the log once per authorized request.
3. **`middlewares/auth.ts`** — `pepDecisionObserver` (already
   `composeObservers(authorizationObserver, auditObserver)`) now also
   composes `policyDecisionEventObserver`. Coverage is exactly the audit
   trail's coverage: every route passing `onDecision: pepDecisionObserver`
   now also emits a bus event.
4. **`scripts/src/test-policy-decision-events.ts`** (new) + `package.json`'s
   `policy:test-decision-events` — also auto-discovered by
   `run-verification-suite.mjs`'s `test-policy-*` glob, no change needed
   there.

## Kill switch

`POLICY_DECISION_EVENTS=all` (default) | `denied` (skip the ALLOW majority,
keep only non-ALLOW effects) | `off`. Unset or a typo'd value falls back to
`all` — a misconfigured env var should never silently disable an audit
stream.

## Deviation from a literal reading of "tie into the EventBus"

The roadmap doesn't specify allowed-vs-denied-only or a volume control; I
added `POLICY_DECISION_EVENTS` because `pepDecisionObserver` sits in front of
`requireAdmin`/`requireDev` and the wider PEP surface — publishing every
`ALLOW` unconditionally means one outbox row per authorized request across
the whole app. `denied` is there for a deployment that wants the audit
signal without that volume; default stays `all` per the roadmap's plain
reading ("every decision").

## Verification actually performed

- **18/18 tests pass** in `scripts/src/test-policy-decision-events.ts`, run
  directly with `tsx --test` (real `PolicyEngine`, real rules, real
  `allow`/`deny`/`stepUp`/`approvalRequired`): correct event type per effect
  including default-deny and the STEP_UP/APPROVAL_REQUIRED-but-still-denied
  case; payload field mapping; no PII/secrets leak (asserted by string
  search for planted secret values in a full JSON dump of the built event);
  `requestId` join-key equality; synchronous-throw and rejected-promise
  publisher failures both swallowed with the decision unaffected; `onError`
  itself throwing is contained; `mode` off/denied behavior including a live
  getter re-read per call; `parsePolicyDecisionEventMode`'s fail-toward-`all`
  behavior on unset/typo'd input.
- **Mutation check**: removed `policyDecisionEventObserver` from
  `composeObservers(...)` and reran — the wiring test (`ok 15`) failed as
  intended, everything else stayed green; restored.
- Every **pre-existing** `test-policy-*.ts` file (decision-observer, audit,
  observability, engine) still passes unchanged, run directly with `tsx`.
- Syntax diagnostics clean on all 4 changed/new TypeScript files.
- `tools/event-catalog-lint.mjs`, `tools/validator-coverage.mjs`,
  `scripts/validate-domain-boundaries.mjs` all still pass — this change adds
  no new event type name and touches no domain boundary, so none of these
  were expected to move, and none did.

## Not verified

- No live DB in this session: the outbox insert itself
  (`publishEventStandalone` inside `lib/policy-decision-events.ts`) and the
  dispatcher delivering to `acie-collector:*` / `mega-engine-audit` were
  **not** exercised end-to-end. The static test confirms the observer is
  wired into `pepDecisionObserver` and that subscribers exist in source for
  both event types; it does not confirm a row makes it from outbox to
  subscriber.
- `run-verification-suite.mjs` (`pnpm exec tsx ...`) could not be run as a
  whole in this sandbox (`pnpm` is not installed here) — every test file was
  instead run individually and directly with `tsx`/`tsx --test`, which is
  what that script itself shells out to per-file.
- Event volume/outbox growth under real production traffic (every `ALLOW`
  through `pepDecisionObserver` is now a row) was not load-tested; `denied`
  mode exists as the mitigation but choosing it is an operator decision, not
  made here.

## Files touched
- `artifacts/api-server/src/lib/policy/events/decision-event-observer.ts` (new)
- `artifacts/api-server/src/lib/policy/events/index.ts` (new)
- `artifacts/api-server/src/lib/policy/index.ts`
- `artifacts/api-server/src/lib/policy-decision-events.ts` (new)
- `artifacts/api-server/src/middlewares/auth.ts`
- `scripts/src/test-policy-decision-events.ts` (new)
- `scripts/package.json`
