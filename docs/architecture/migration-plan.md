# AYZEN migration plan

1. Characterize current monolith behavior and authorization.
2. Register domain ownership, event vocabulary, and API contracts.
3. Add the target service's owned schema adapter without cross-domain reads.
4. Back up and backfill data; validate counts, checksums, and permissions.
5. Enable dual-read only when consistency checks are observable.
6. Switch reads, then writes, with an explicit rollback switch.
7. Monitor errors, latency, queue depth, and dead letters.
8. Remove the old dependency only after the rollback window expires.

The gateway's route matrix and `artifacts/api-server/src/lib/migration-registry.ts`
are the source of truth for cutover state. No route is extracted by deployment
configuration alone.