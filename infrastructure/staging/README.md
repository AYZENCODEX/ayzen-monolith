# Staging checklist

Staging must use managed PostgreSQL, Redis/event infrastructure, object
storage, and a secret manager. Do not use the local Compose credentials.

Before enabling a strangler route:

1. Apply and verify the owned schema migration.
2. Run characterization, contract, security, and failure-recovery tests.
3. Back up the source data and record the restore point.
4. Validate backfill counts and checksums.
5. Enable one route family for a controlled cohort.
6. Monitor error rate, latency, queue depth, and dead letters.
7. Keep the monolith fallback and rollback switch available.

Required smoke checks are documented in `docs/operations/staging-runbook.md`.