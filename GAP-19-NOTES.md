# VLT-GAP-19 — Runtime / chaos / recovery (Hardening H2)

**Gate:** `pnpm validate:vault-chaos` -> `reports/antas/vault/gap/VLT-GAP-19/gate.json`. Blocking step in `.github/workflows/ci.yml` and `ci/enforcement-pipeline.yml`, before GAP-18. One script: `scripts/antas/vault/gap/validate-vlt-gap-19.mjs`. Ledger re-sealed (`pnpm seal:vault-evidence`).

## Method
The real Vault TypeScript is transpiled and run against an in-memory database / network / clock. Faults are injected at **every I/O point**, before and after the operation applies:
- **crash**: process dies; later I/O from that run is refused. "Restart" = fresh module graph over the surviving state 61 min later (past the stale-lock window), then the normal recovery path / client retry.
- **error**: one operation fails (not applied / applied-but-reported-failed), process keeps running.
- **outage**: all DB calls (DB loss) or all network calls (storage/provider failure) fail for a run, then heal.

Scenarios (roadmap tasks 1-12): seed reveal, scheduled backup worker (store/email/webhook, overlapping ticks, DB outage, delivery outage), entity create (+event faults), entity update, automatic and manual key rotation, snapshot restore. 14 scenarios, 236 I/O points, 382 fault runs.

Invariants after every run: no corruption, no duplicate critical side effect, no plaintext leak, no missing key-rotation audit, no unrecoverable state, no unhandled rejection. 11 planted defects (incl. reverts of the fixes below) must each be caught.

## Real defects found and fixed
1. `createEntity` / `updateEntity` fell back to a reduced insert/update on **any** DB error: a transient error stored an entity without seed phrase + credentials (or inserted a second row when the first had committed) and answered success. Now only on a missing-column error (`vault/domain/db-errors.ts`).
2. A throwing event hub turned a committed create/update into an error response. Broadcast is now best-effort in create/update.
3. Rotation interrupted between deactivate and insert left a chain with no active key that the sweep ignored forever. The sweep now rotates to restore one.
4. Rotation interrupted between key commit and its audit row left a key with no `key_rotated` audit event. The sweep now reconciles it (`trigger: "reconciled"`; also writes one row for the current key once on first run if it was never audited).

5. `applyRestoreDiff` caught per-row insert errors inside one PG transaction without savepoints: after one failed statement Postgres aborts the transaction, the commit rolls back, and the response still reported rows as restored. Each row insert now runs in a SAVEPOINT (`rowSavepoint`): a failing row is skipped and reported, the others commit, `restored` equals what is committed. The gate now asserts this as an invariant (13 planted defects incl. a savepoint revert).

6. Seed reveal wrote its `seed_revealed` audit row fire-and-forget, so a transient failure of that insert delivered the seed with no audit. The row is now written (new `logVaultActivityStrict`) before the plaintext is returned and before any charge; if it can't be written the reveal answers 503 `REVEAL_AUDIT_UNAVAILABLE` (nothing revealed or charged; retry with a fresh token). Gate asserts delivered => audited in every fault run (13 planted defects).

7. A scheduled backup worker killed after storing its snapshot was re-run from scratch after the stale-lock window and stored a second snapshot (eating retention quota). The re-run now finds the interrupted run's snapshot (scheduled, live, newer than the schedule's `lastRunAt`), reuses it, skips a delivery already recorded as successful, and completes the bookkeeping (`selectInterruptedScheduledSnapshot`, `hasSuccessfulDelivery`). Gate asserts no extra snapshot in any fault run (14 planted defects, incl. the revert).

8. POST /vault now honours an optional `Idempotency-Key` header (migration 121, `vault_create_idempotency`): the entity serial is pinned to (user, key) before the insert, so a retry after a lost response returns the entity the first attempt created, or re-uses the pinned serial if it died before inserting. Exactly-once in every fault run (15 scenarios, 15 planted defects). Keys are not purged yet (index on created_at supports a TTL job). Client wiring is not done: it needs the generated API client to send the header.
9. The `vault_backup_scheduled_run` activity row was written once and its failure swallowed, so a transient error left a stored snapshot with no audit row. `logActivity` now accepts `{ throwOnError }` and the scheduler retries the row up to 3 times; the gate treats a missing row as a hard violation (planted defect: retry removed). A retry after an applied-but-errored insert can leave a duplicate row, accepted as better than a missing one.

10. Seed reveal charged again on the retry after a lost response. `chargeCredits` now takes `{ referenceId, dedupeWithinMs }` and does the balance debit + ledger row in ONE transaction (credits row locked first); reveal passes `seed:<id>` and a 5-minute window, so a retry inside it finds the ledger row and is not charged, while a deliberate reveal later is charged normally. The real `chargeCredits` runs in the gate against the fake ledger (conservation: balance == 100 - sum of debits after every crash/error). Note: this is a behaviour change: a second reveal of the same seed within 5 minutes is free.

11. A backup redelivered after a crash between the receiver accepting it and the delivery being recorded was indistinguishable from a new backup. Exactly-once to an external system is impossible from this side, so every channel now carries a stable identity: webhook `Idempotency-Key: vault-snapshot-<id>`, email `Message-ID: <vault-snapshot-<id>@backup.ayzen.tech>` (`sendEmail` gained optional `messageId`/`headers`), Dropbox uploads with `mode: overwrite` (was add + autorename = a `(1)` copy), Drive skips a file of that name already in the backup folder (was a second file). The gate runs the real delivery.ts + cloud.ts against a Drive/Dropbox model and requires that any redelivery carries the same identity. 15-backup differential records the Drive/Dropbox change as an asserted intentional change (`cloud-intentional` cells).

12. The web client did not send the `Idempotency-Key` the server already honours. The create flow (artifacts/ayzen/.../vault.tsx) now sends a key per distinct payload, keeps it across retries of the same payload, drops it after success, and a key per entry on import. CORS already allowed the header. Checked statically by the gate (the browser code is not executed).

## Accepted residuals (measured, bounded, listed in gate.json — not hidden)
- create: a POST /vault WITHOUT an `Idempotency-Key` header that committed but lost its response is still retried into a second entity. The web client now sends the key, so this only affects other API callers; the server cannot tell a header-less retry from a new create (making the header mandatory would change the API contract).

Not a residual any more, but a dependency: a backup can still be SENT twice after a crash. It is now identifiable and harmless only if the receiver honours the identity (webhook Idempotency-Key, email Message-ID); Drive/Dropbox are idempotent by file name. The gate counts these redeliveries (`stats.redeliveries_carrying_the_same_identity`) and fails if one lacks the identity.

## Limits
In-memory model, not Postgres; kill injected at I/O boundaries; payload builder, alert channels, transports, SSE hub are fakes; share/attachment/KYC/game writes, health cron, field-key `rotateKey`, cloud OAuth not covered. Rotation is repaired by the daily sweep, not made atomic (needs a key-store port change + re-baselining the 15-backup differential).

## Changed besides the gate
create.ts, update.ts, restore.ts (savepoints), 15-C + `vault-equivalence-replay.json` (new reviewed `intentional_changes` allowance for the PATCH db-throws cell, evidence-checked and rejected if stale), key-rotation-cron.ts, audit.ts (+`hasKeyRotationAudit`), new domain/db-errors.ts; package.json, both CI files; file-migration-map regenerated (GAP-17); gate 13/14/16 ci-wiring evidence regenerated; ledger sealed.
