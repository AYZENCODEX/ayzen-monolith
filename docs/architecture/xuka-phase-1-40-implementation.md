# XUKA phases 1–80 implementation

Status: **implemented as shared repository controls and Admin-visible
operational contracts**.

The imported roadmap renumbers the remaining AYZEN work from its former
phases 71–150. The implementation is intentionally centralized in
`packages/xuka` rather than duplicated across 40 thin services. It gives the
runtime one source of truth for phase status, service/startup checks, migration
gates, API contracts, Telegram command handling, Admin safety, and database
boundaries.

## Delivered

| Phases | Delivered capability |
| --- | --- |
| 1–5 | Service/port registry, dependency-ordered startup plan, environment validation, lockfile metadata, and clean-boot checks. |
| 6–12 | Migration ownership metadata, deterministic registry/runner, dependency checks, schema-drift detection, isolated bootstrap plans, and upgrade plans. |
| 13–20 | Endpoint inventory, versioned API contracts, route plans with monolith fallback, typed error contracts, idempotency coordination, and trace/correlation contexts. |
| 21–30 | Catalogued Telegram commands, layered hierarchy, scope-aware command authorization, receipt deduplication/failure tracking, and Admin/product bot coverage. |
| 31–38 | Dedicated Admin service endpoints for phase status, phase detail, registry evidence, contract validation, and non-mutating operation previews; existing audit, auth, policy, and event hooks remain mandatory. |
| 39–40 | Database ownership lookup plus an explicit shared-data contract that denies undeclared cross-app actions by default. |
| 41–46 | API/event access, service scopes, per-app policy, OIDC boundary validation, security checks, and continuous boundary validation. |
| 47–54 | Event-first contracts, versioned event schemas, workflow orchestration/retry, idempotency, DLQ recovery, intelligence/audit integration, and bypass checks. |
| 55–60 | Canonical context, propagation, service/feature access validation, diagnostics, and context security checks. |
| 61–66 | Canonical resource IDs, ownership hierarchy, registration, reconciliation, orphan detection, and resource API/UI models. |
| 67–73 | Dependency graph, transitive impact, cycle/orphan/unused API-event detection, runtime-vs-declared comparison, and impact UI data. |
| 74–80 | Hierarchical configuration, schema validation, versioned safe updates, overrides, rollback, audit history, and Admin UI metadata. |

## Admin operations

When the Admin service is enabled, authorized operators can use:

- `GET /api/admin/xuka/phases`
- `GET /api/admin/xuka/phases/:phase`
- `GET /api/admin/xuka/registry`
- `POST /api/admin/xuka/validate`
- `POST /api/admin/xuka/preview`
- `POST /api/admin/xuka/inspect`

All operations require `admin:read`, are audited, and previews never mutate
data. Existing Admin writes continue to require explicit confirmation,
transaction IDs where applicable, and break-glass controls.

## Verification

```text
node scripts/validate-xuka-1-80.mjs
```

This validates all 80 phase registrations, dependency ordering, fail-closed
boot checks, deterministic migration execution, drift detection, endpoint and
Telegram catalogs, Admin default-deny behavior, operation previews, and the
shared-data boundary.

The code-level phases are complete. Production exit gates still require
provider-backed databases, Telegram credentials, real traffic fixtures, and
authorized operational sign-off; none are fabricated by this repository.