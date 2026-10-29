# Phase 07 — Unified Policy Decision Contract

Roadmap source: *AYZEN Deep Gap Audit and 40-Phase Claude Enforcement Roadmap*, Phase 07.
Scope: one decision interface consumed by API, service, event, workflow, scheduler, Telegram and Admin.
Definition of done: one policy decision contract with app-scoped namespaces.
Verification: allow/deny/conditional regression suite.

## What changed

**New: `packages/policy-contract`** — `decide()`, `explain()`, `createConsumerClient()`, `CONSUMERS`, `DECISIONS`.
It composes the existing engines (`@ayzen/authorization` capability, route-gate and policy-pack engines; `@ayzen/platform-governance` PDP) and normalizes their vocabularies into `allow | deny | conditional`. `step_up_required` maps to `conditional` with `conditions[0].code = "STEP_UP_REQUIRED"`. Unknown engine output, unknown targets and unknown consumers fail closed / throw. Every decision carries `app`, `namespace`, `consumer`, `traceId`, `audit: true`.

**Extended (additive): `schemas/policy/decision.v1.json`** — `decision` enum gains `conditional`; new optional `conditions`, `namespace`, `consumer`. All Phase 06 fields unchanged.

**Extended (additive): `packages/platform-governance` `createPolicyDecisionPoint`** — a policy entry or policy function may now return `"conditional"` or `{ decision: "conditional", conditions, reason }`. `true`/boolean behavior is unchanged; decisions gain `conditions: []`.

**Updated: `services/policy`** — passes conditional outcomes through and tags decisions with `consumer` (default `"service"`). `packages/service-runtime` already calls this, so every extracted service now sits on the contract with no change to its own code.

**New consumer adapters** (thin clients over `createConsumerClient`, no logic duplicated):

| Consumer | File |
|---|---|
| api | `packages/api-contracts/src/policy-contract-adapter.mjs` |
| service | `services/policy/src/index.mjs` (via service-runtime) |
| event | `packages/event-client/src/policy-contract-adapter.mjs` |
| workflow | `packages/workflow/src/policy-contract-adapter.mjs` |
| scheduler | `services/scheduler/src/policy-contract-adapter.mjs` |
| telegram | `packages/telegram/src/policy-contract-adapter.mjs` |
| admin | `services/admin/src/policy-contract-adapter.mjs` |

**New gate: `npm run validate:policy-contract`** (`scripts/validate-policy-contract.mjs`) — checks all seven consumers are wired, the schema enums match `CONSUMERS`, and the contract really produces all three decisions.

## Verification (run in this sandbox)

30/30 tests pass across: `packages/policy-contract/test` (13), the six adapter test files, `tests/policy/policy-decision-contract-phase7.test.mjs` (the allow/deny/conditional regression suite run through `services/policy-simulation`, including its determinism check), and the untouched Phase 06 `tests/policy/platform-policy.test.mjs`. `validate:policy-contract` passes. `generate-endpoint-registry --check` still reports up to date.

Bug found and fixed while testing: the contract initially dropped the caller's `actorType` and always reported `"user"`; scheduler tests (service actor) caught it.

## Known limitations (honest scope)

1. **Adapters are not yet injected into each consumer's live request path** (workflow executor step loop, scheduler trigger path, event publish path, API gateway). They are tested, importable clients; wiring each call site is follow-up work per consumer.
2. **`conditional` is denied by `packages/service-runtime`'s synchronous gate** (it only allows `decision === "allow"`). This is fail-closed and safe, but no step-up challenge response exists there yet. Telegram already renders `STEP_UP_REQUIRED` via `formatTelegramError`.
3. **`authorization:authorize` / `authorization:explain-policy` contract exceptions are not closed.** `decide()`/`explain()` are the code-level surface, but the coverage tool resolves operations only via `ENDPOINT_REGISTRY` HTTP routes. Adding routes to `services/policy` would create a circular dependency (`service-runtime` already imports `services/policy`), and I could not verify an `artifacts/api-server` TS change in this sandbox. The exception entry (expires 2027-03-31) is left as is.
4. **Pre-existing, unrelated failure:** `packages/service-runtime/test/capability-gate.test.mjs` fails 1 of 12 (403 vs 200) identically on the untouched original zip.
5. Tests need workspace resolution (`pnpm install`); I verified using temporary `node_modules/@ayzen/*` symlinks that are **not** included in the deliverable.
