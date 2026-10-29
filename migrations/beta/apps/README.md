# Per-application migration manifests

Every application boundary has a manifest in this directory. The manifest
must identify the owner, source and target, beta isolation key, rollback
action, and the four migration categories:

```text
features/
architecture/
security/
infrastructure/
```

The files are JSON manifests rather than SQL files so that the migration
control plane can plan and validate application extraction independently from
Drizzle's database migration history. SQL remains in `migrations/` and is
still applied by the existing database tooling.