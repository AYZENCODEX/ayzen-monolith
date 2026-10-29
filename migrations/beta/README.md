# AYZEN hybrid migration and beta system

This directory is the control plane for moving AYZEN from the compatibility
monolith toward independently runnable microservices without losing rollback
or tenant boundaries.

## Layout

```text
migrations/beta/
├── apps/                 # One manifest per application/service boundary
├── transferred/          # Legacy SQL copied with P### + A### unique names
├── central-website/      # The central AYZEN website migration
├── shared/               # Shared workspace, identity, event, and audit contracts
├── serial-registry.json  # Source/target checksums and app/project serials
├── deployed-only.json    # Deployed-but-unbacked SQL reconciliation register
├── registry.json         # Machine-readable catalog and gate policy
└── README.md
```

Each app migration is classified under exactly four concerns:

- `features/` — user-facing capability and data movement
- `architecture/` — routes, service ownership, contracts, and dependencies
- `security/` — identity, authorization, tenant scope, audit, and rollback controls
- `infrastructure/` — runtime, queues, storage, backups, and observability

The category is part of the migration ID (`features.*`, `architecture.*`,
`security.*`, or `infrastructure.*`). This keeps app-specific work searchable
without creating a second migration system beside the existing SQL migrations.

## Safe beta lifecycle

1. Register the app and owner in `registry.json`.
2. Inventory current behavior and dependencies.
3. Create an isolated target and backup.
4. Backfill, compare counts/checksums, and run permission checks.
5. Enable dual-read, then read and write cutover one step at a time.
6. Roll back by disabling the route and restoring monolith traffic if any gate
   fails.
7. Remove the old dependency only after the rollback window expires.

No beta plan may advance without `backup`, `validation`, and `rollback` gates.
The catalog rejects irreversible entries and unresolved dependencies by
default. Actual provider credentials, production URLs, and deploy approvals
remain environment inputs; they are never committed here.

## Commands

```text
node scripts/validate-migration-beta.mjs
node scripts/validate-connectivity.mjs
```

The JSON registry is intentionally declarative. Runtime planning and
confirmation checks live in `packages/migration/src/beta.mjs`; transport and
trace/tenant enforcement live in `packages/connectivity/src/index.mjs`.

## SQL transfer naming

The beta transfer keeps the old files as an archive and writes a reviewed copy
under `migrations/beta/transferred/<app>/`. Every transferred file has both
serials in its filename:

```text
P106_A007_identity__119_ak4_phase1a_rbac_capability_coverage.sql
```

`P106` is unique across the whole project; `A007` is unique inside the
identity app. The transfer tool only copies static SQL and verifies SHA-256
checksums. It never interpolates app names, schemas, or request values into
SQL. Deployed statements that have no source file are registered separately
until their exact SQL is recovered.