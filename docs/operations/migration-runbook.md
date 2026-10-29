# Migration runbook

1. Review the ordered SQL files in `migrations/` and the ownership ledger in
   `infrastructure/migrations/ledger.json`.
2. Take and record a provider-managed backup before applying a production
   migration.
3. Apply migrations once with the deployment migration job. Never run the same
   SQL manually from two workers.
4. Record before/after row counts, checksums for backfills, and the migration
   identifier in the release evidence.
5. Run `node --test tests/restore/restore-evidence.test.mjs` and the relevant
   contract/security tests.
6. If a migration is not safely reversible, use the documented forward-fix and
   the application rollback switch; do not delete production data to restore an
   older binary.

Production execution requires an approved change owner and a tested restore
point. Synthetic staging data is the only data permitted for rehearsal.