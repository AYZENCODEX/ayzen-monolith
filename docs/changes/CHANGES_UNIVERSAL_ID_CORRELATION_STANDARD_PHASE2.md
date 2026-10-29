# AYZEN 40-Phase Enforcement Roadmap — Phase 02: Universal ID & Correlation Standard

## Scope (from the roadmap)
- Deliverables: `packages/identity-context/*`, `packages/correlation/*`, `schemas/platform/identifiers.json`
- Definition of done: one traceable identity chain across synchronous and async paths.
- Verification: propagation tests across API → event → workflow → worker.

## যা যোগ করা হলো

| ফাইল | কী আছে |
|---|---|
| `schemas/platform/identifiers.json` | **নতুন** — seven id types (`requestId`, `traceId`, `correlationId`, `causationId`, `eventId`, `workflowRunId`, `deploymentId`) এর shared `instanceId` pattern, প্রতিটার generator, HTTP/event-envelope/workflow-context propagation field, causation rule, propagation requirement |
| `packages/identity-context/src/index.mjs` | **নতুন** — `isValidId`/`assertId`/`normalizeId` (validation), `generateId` (UUIDv4), `createIdentityContext()` (entrypoint hop: শুধু genuinely absent হলে নতুন traceId/correlationId mint করে — একটা valid incoming id কখনো discard করে না), `deriveChildContext(parent, overrides)` (traceId/correlationId parent থেকে unchanged carry করে, causationId default হয় parent-এর hopId) |
| `packages/correlation/src/index.mjs` | **নতুন** — `createCorrelationChain()`: hop record করে, তারপর তিনটা জিনিস verify করে — (1) পুরো chain-এ ঠিক একটাই correlationId (2) entrypoint বাদে প্রতিটা hop-এর causationId একটা real recorded hop-কে resolve করে, correlationId/traceId-এর copy না (3) কোনো hop-এ hopId/traceId/correlationId missing না। `findings()` + `status()` (`READY`/`BLOCKED`) |
| `packages/identity-context/test/index.test.mjs`, `packages/correlation/test/index.test.mjs` | **নতুন** — `node --test`, দুটোই pass (18/18): id generation/validation, propagation preservation বনাম fresh-mint-on-invalid, causationId derivation, আর correlation package-এ প্রতিটা finding code (`MISSING_CAUSATION_ID`, `CORRELATION_ID_DIVERGED`, `CAUSATION_ID_NOT_A_PARENT_POINTER`, `CAUSATION_ID_UNRESOLVED`)-এর জন্য আলাদা negative-path test |
| `tools/identity/validate.mjs` | **নতুন** — identifiers.json-এ নিজেই যেটা reference করে সেই verification script। একটা clean API→event→workflow→worker chain simulate করে assert করে ঠিক একটাই correlationId + resolvable causation chain; একটা deliberately-broken variant (propagation না মেনে fresh traceId/correlationId mint করা হয়) simulate করে assert করে সেটা `CORRELATION_ID_DIVERGED` হিসেবে ধরা পড়ে এবং `BLOCKED` status দেয় — মানে verifier আসলেই যেটা catch করার কথা সেটা catch করে, শুধু happy-path না |

## Definition of done — status
- ✅ একটাই traceable identity chain সব sync/async hop জুড়ে — `deriveChildContext` কখনো traceId/correlationId regenerate করে না, শুধু causationId পরের hop-এ chain করে।
- ✅ Propagation test API→event→workflow→worker — `tools/identity/validate.mjs`-এ (দুটো direction-ই: positive + negative)।

## যা এই ফেজে touch করা হয়নি
- কোনো existing route/middleware/`app.ts` এই ফেজে wire করা হয়নি — এই দুটো package সম্পূর্ণ standalone, import না করলে বাকি অ্যাপের কোনো behavior বদলায় না। Real HTTP header/event-envelope/workflow-context field-এ এই context বসানো (`x-request-id`, `x-trace-id`, ইত্যাদি) একটা future route-integration phase-এর কাজ, Phase 02-এর না — Phase 02 শুধু standard + verification primitive টা প্রতিষ্ঠা করে।
- Phase 01-এর component id format (`<kind>:<original-id>`, `@`/`/` allowed) থেকে Phase 02-এর instance id format ইচ্ছাকৃতভাবে আলাদা রাখা হয়েছে (`schemas/platform/identifiers.json`-এর description-এ note করা আছে) — দুটো জিনিস মিশিয়ে ফেললে component registry-এর id আর runtime-minted id-এর মধ্যে সংঘর্ষ (collision) হতে পারত।
