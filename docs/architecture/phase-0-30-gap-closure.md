# AYZEN phases 0–30 — contract and governance closure

Status: **repository implementation complete; provider and production cutover
remain explicit deployment inputs**.

This document records the executable controls that close the gaps left by the
phase summaries. It does not claim that a cloud account, Telegram token,
database provider, DNS record, or production workload identity exists.

## Canonical registries

- `packages/domain-boundaries` and
  `infrastructure/platform/domain-contract-registry.json` define owners,
  resources, public operations, and event surfaces.
- `packages/endpoint-registry` and
  `infrastructure/platform/endpoint-registry.json` define API ownership,
  authentication mode, capability permission, timeout, retry, idempotency, and
  audit classification.
- `packages/events` requires registered event types, versions, owners, payloads,
  trace IDs, and correlation IDs. `packages/contracts` supplies common success,
  error, page, and cursor-page envelopes.
- `infrastructure/platform/telegram-bot-contract.json` is the nine-bot
  transport contract. Webhook transport remains separate from identity,
  authorization, and domain workflows.

## Admin control plane

Admin full-database access is not exposed to browsers and is not implemented as
raw SQL. `packages/admin-data` provides an allowlisted resource catalog,
field/filter validation, tenant-independent policy checks, write
confirmations, transaction requirements, sensitive-resource controls, and a
hard-disabled delete operation. `services/admin` calls an explicitly
configured data provider through `/admin-data`; without that provider it fails
closed with `503`.

Admin state and the append-only hash-chained audit store are persisted through
the configured `ADMIN_STATE_PATH` and `ADMIN_AUDIT_PATH` files. Break-glass
grants require an authorized actor, a reason, explicit confirmation, a
short-lived single-use grant, and audit/event publication. The grant cannot be
used by a different actor.

## Telegram controls

Telegram callback payloads are HMAC-SHA256 signed and expire after five minutes.
Sessions bind the bot key, Telegram user, and workspace. Commands resolve to
capabilities; gateway forwarding never performs database mutations or domain
business logic.

## Validation

Run:

```text
node scripts/validate-roadmap-0-30.mjs
```

The validator is deliberately runnable without production credentials or
provider dependencies. `scripts/validate-domain-boundaries.mjs`,
`scripts/validate-service-boundaries.mjs`, and the existing cloud/CI/maturity
validators remain separate gates.