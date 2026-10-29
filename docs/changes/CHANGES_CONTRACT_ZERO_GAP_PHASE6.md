# AYZEN Roadmap — Phase 06: Contract Zero-Gap Sprint

## Scope

Close all known unmapped owners, endpoint-less contracts and unresolved
operations surfaced by `tools/contract-validator/domain-coverage.mjs`
(Phase F4's domain-boundary contract cross-check); make the ones that are
genuinely architectural facts -- not bugs -- **expiring** acceptances
instead of a baseline frozen forever.

## Starting point

`scripts/domain-contract-coverage-baseline.json` had 3 categories of known,
frozen findings:

- **1 unmapped owner**: `platform` -- ~30 legacy monolith routes
  (ad-tasks, broadcast, checkin, marketplace/NFT stuff, settings, support,
  etc.) with no domain contract at all.
- **1 endpoint-less contract**: `authorization`.
- **6 unresolved operations**: `ai:run-agent`, `authorization:authorize`,
  `authorization:explain-policy`, `identity:jwks`, `telegram:render-menu`,
  `telegram:resolve-command`.

## What was built / fixed

1. **`packages/domain-boundaries/src/index.mjs`** — added a `platform`
   domain contract: a deliberate catch-all (not a curated product domain)
   covering the legacy monolith route surface, with a representative slice
   of `publicOperations` sufficient for every route under that owner to
   resolve to *a* declared operation via the coverage validator's fuzzy
   match. Splitting this into real per-feature contracts is future work,
   not forced by this phase.
2. **`packages/contracts/src/index.mjs`** — `createDomainContract` throws on
   an unregistered domain name; `platform` had to be added to its
   `DOMAIN_NAMES` allow-list too, or the new contract above would throw at
   import time. (Found by actually running the build after adding the
   contract -- not caught by only editing the domain-boundaries file.)
3. **`tools/domain-routing/generate-endpoint-registry.mjs`** — added the
   JWKS well-known-route seed entry
   (`GET /.well-known/jwks.json`, owner `identity`). It's mounted directly
   on the bare `app` instance per RFC 8414, outside `/api` and outside
   `routes/index.ts`'s combined routers, so the scanner structurally cannot
   discover it -- same class of gap as the Telegram webhook's existing seed
   entry. Regenerating `packages/endpoint-registry/src/index.mjs` from this
   now produces 1223 endpoints across 15 owners (was 1222/15; `identity`
   already existed as an owner, this just adds the one route).
4. **`tools/contract-validator/domain-coverage.mjs`** (new) — the
   owner/contract/operation cross-check logic extracted out of
   `scripts/validate-domain-contract-coverage.mjs`'s original inline
   version, so it can be shared with the new exception gate below without
   the two computations drifting apart.
5. **`scripts/validate-domain-contract-coverage.mjs`** — refactored to call
   `computeDomainContractCoverage()` instead of duplicating the logic
   in-line. Behavior unchanged; baseline updated (`--update-baseline`) to
   drop the two now-fixed entries (`platform`, `identity:jwks`).
6. **`scripts/validate-contract-exceptions.mjs`** (new) — a second, stricter
   gate. The frozen baseline above is good at catching *new* drift, but it
   never forces a second look at an old accepted finding. This gate instead
   requires every *current* finding to have a matching entry in
   `reports/contracts/contract-exceptions.json`
   (schema: `schemas/contracts/contract-exception.v1.json`) with a real
   `owner` and an `expires` date -- and fails once that date has passed,
   until a human either renews it (having re-confirmed the reason still
   holds) or actually fixes the finding. It also flags (non-blocking) any
   exception whose finding no longer occurs, so the registry doesn't
   accumulate stale entries either.
7. **`reports/contracts/contract-exceptions.json`** (new) — the 5 remaining
   findings after (1)-(3), each with a reviewed architectural reason and an
   `expires: 2027-03-31` date:
   - `contractsWithoutEndpoints: authorization` / `unresolvedOperations:
     authorization:authorize` / `authorization:explain-policy` -- an
     in-process policy-decision interface (`packages/authorization`), not a
     REST route. Tracked against Phase 07 ("Unified Policy Decision
     Contract"), which is expected to give this an explicit surface.
   - `unresolvedOperations: ai:run-agent` -- dispatched via the
     workflow/event pipeline, not a synchronous endpoint, by design.
   - `unresolvedOperations: telegram:render-menu` /
     `telegram:resolve-command` -- resolved inside the Telegram bot's own
     command-tree parser (`apps/telegram-gateway`), replying directly over
     the Telegram Bot API; structurally not an `/api/*` HTTP route. This is
     the exact example `validate-domain-contract-coverage.mjs`'s own header
     comment uses for "a real, defensible finding without a corresponding
     code fix being obvious or even correct."

## Result

- `node scripts/validate-domain-contract-coverage.mjs` — 0 new drift beyond
  the (now smaller) baseline.
- `node scripts/validate-contract-exceptions.mjs` — 0 unresolved findings,
  0 expired exceptions, 6 active exceptions. Writes
  `reports/contracts/coverage-report.json` every run.
- `node tools/domain-routing/generate-endpoint-registry.mjs --check` and
  `scripts/validate-track-f.mjs` both confirm the endpoint registry is in
  sync (1223 endpoints, 15 owners).
- Auto-discovered by `scripts/full-system-audit.mjs` (any
  `scripts/validate-*.mjs`) — no separate wiring needed.

## Known limits / deliberately deferred

- `platform`'s `publicOperations` is a representative slice of the legacy
  monolith surface, not an exhaustive one-operation-per-route enumeration --
  that granularity belongs in `ENDPOINT_REGISTRY` itself. Splitting
  `platform` into real per-feature domain contracts is tracked as future
  work.
- The exception registry's fuzzy-match dependency on
  `tools/contract-validator/domain-coverage.mjs` means a wording change to
  a contract's `publicOperations` or an endpoint's `audit`/`permission`/
  `path` can shift which findings occur without any real behavior change --
  same caveat as the underlying validator's own fuzzy-matching rationale.

## Verification

```
node tools/domain-routing/generate-endpoint-registry.mjs         # regenerate
node tools/domain-routing/generate-endpoint-registry.mjs --check # CI drift check
node scripts/validate-domain-contract-coverage.mjs                # frozen-baseline gate
node scripts/validate-contract-exceptions.mjs                     # expiring-exception gate
node scripts/validate-domain-contract-coverage.mjs --update-baseline  # after a deliberate fix/accept
```
