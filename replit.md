# AYZEN workspace notes

## Architecture

This repository is a pnpm workspace containing a compatibility monolith and
gateway-fronted, independently runnable service boundaries. The gateway
defaults every route to the monolith. An extracted service is enabled only by
setting its route URL after its migration gates pass.

## Local commands

```text
pnpm install --frozen-lockfile
pnpm --filter @ayzen/api-gateway start
pnpm --filter @workspace/api-server dev
node scripts/validate-service-boundaries.mjs
node scripts/validate-phase-1-11.mjs
pnpm validate:shared-platform-1-30
```

The gateway expects the monolith at `MONOLITH_URL` (default
`http://127.0.0.1:8080`). Do not hardcode secrets; use the workspace secrets
manager or deployment secret manager.

## Database targets

Keep Replit's runtime-managed `DATABASE_URL` for the isolated development/test
database. App processes require `APP_DATABASE_URL` and fail closed when it is
missing; they never fall back to the test database. Store the rotated Supabase
connection as the `APP_DATABASE_URL` secret; do not recreate a
`DATABASE_URL` secret override. Database tests explicitly select Replit's
development database with `DATABASE_URL_TARGET=replit-test`. The Drizzle schema
config requires `APP_DATABASE_URL` and rejects the Replit test target because
push operates on the complete application schema, not a Finance-only subset.
Use a reviewed, explicitly scoped test migration or fixture when schema setup
is needed; do not run another broad push against the test database.

For a local multi-process topology, see
`infrastructure/docker/docker-compose.yml`. The staging and rollback process is
documented in `docs/operations/`.

## Roadmap validation

The uploaded 50-phase roadmap is represented by
`infrastructure/platform/roadmap-1-50.json`. Run
`pnpm validate:roadmap-1-50` for the machine-readable phase, registry,
universal-circuit, completeness, worker-isolation, and approval-control gate.
The reusable architecture graph engine is in `packages/architecture`.

The STRA 50-phase contract is represented by
`infrastructure/platform/roadmap-stra-1-50.json`. Run
`pnpm validate:stra-1-50` for the Spider-Wave graph, AYZEN.tech domain
fabric, Migration Beta 2.0, Telegram Command OS, and Cloud Compute Fabric
gate.

The hybrid app identity contract is represented by
`infrastructure/platform/hybrid-identity-manifest.json`. Run
`pnpm validate:identity-1-15` for the 15-phase local-account, AYZEN/OIDC,
explicit-linking, profile-ownership, session, policy, event, Telegram, and
readiness gate. Its executable domain engine is in `packages/identity`.

The combined API/security/EventBus/Workflow backbone contract is represented by
`infrastructure/platform/roadmap-api-security-eventbus-workflow-1-50.json`.
Run `pnpm validate:api-security-backbone-1-50` for the 50-phase API boundary,
security kernel, connector, resilience, EventBus, Workflow, outbox/inbox,
replay, observability, Admin/Telegram, and full-circuit gate.

## Shared platform phases 1–30

The shared platform and integrated-enforcement roadmap is represented by
`infrastructure/platform/shared-platform-roadmap-1-30.json`. Its machine
validation covers the shared service catalog, service discovery, EventBus
governance and operations, workflow/scheduler leases, notification delivery,
policy namespaces and simulation, identity/config/coordination/quota/health,
admin operations, the universal circuit, and the phase 26–30 integration graph
and runtime quarantine controls.

Run:

```text
pnpm validate:shared-platform-1-30
node --test tests/contracts/platform-contracts.test.mjs tests/policy/platform-policy.test.mjs tests/scheduler/shared-scheduler.test.mjs
```

The frontend preview uses the existing `Start application` workflow. Vite
defaults to port `5000` and base path `/` when those environment variables are
not supplied; deployment environments can still override `PORT` and
`BASE_PATH`.

## ANTAS assurance

The ANTAS phases 0–18 are represented by a machine-readable manifest and
reproducible evidence runner:

```text
pnpm antas:baseline
pnpm antas:subphases
pnpm antas:validate
```

`config/antas/subphases.json` tracks all 69 roadmap sub-phases from 00.1
through 18.2. `pnpm antas:subphases` checks each sub-phase's repository
evidence and writes individual reports under
`reports/antas/ANTAS-XX/subphases/`. Repository evidence is separated from
runtime, provider, staging, production, and release-owner evidence; the latter
remain `UNVERIFIED` until those drills are run and recorded.

Repository/static gates report `implemented` when evidence is present.
Provider-backed staging, production traffic, destructive restore, load,
rollback, and release-owner approval remain explicitly `UNVERIFIED` until
those drills produce evidence. Generated reports are under `reports/antas/`.

## Vault modularization certification

The VLT-00 through VLT-19 Vault modularization gates are generated and checked
by:

```text
pnpm validate:vault
```

The command generates the VLT manifest, inventories, 80 sub-phase validators,
per-gate evidence under `reports/antas/vault/`, and
`reports/antas/vault/FINAL-CERTIFICATION.json`. Repository/static compatibility
gates can pass without claiming provider-backed staging or production behavior;
those drills must be recorded separately when an environment is available.