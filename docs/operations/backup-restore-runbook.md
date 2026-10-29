# Backup and restore runbook

Backups must be provider-managed, encrypted, checksum-verified, and retained
according to `infra/backup/policy.json`. A backup is not certified until it has
been restored into an isolated environment.

## Backup

- Record the snapshot identifier, creation time, encryption key version, and
  retention class.
- Verify the object checksum and that the application can read the catalog.
- Keep production credentials in the provider secret manager.

## Restore drill

1. Stop writes to the isolated target.
2. Restore the database and object data into a new namespace.
3. Verify row counts, checksums, foreign keys, and encrypted vault readability.
4. Start the application against the isolated target and exercise `/live` and
   `/ready`.
5. Record the result in `reports/ziox/C5-restore.json`.

Never restore a production snapshot over the live database during a drill.