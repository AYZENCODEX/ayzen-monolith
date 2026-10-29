# AYZEN SOTA Phase 1–60 implementation

This document is the repository implementation record for the SOTA Phase 60
roadmap in `attached_assets/AYZEN_SOTA_PHASE_60_Phase_Implementation_Roadmap_1790622558909.docx`.

## Completion model

The code gate is deterministic and is run by
`node scripts/validate-sota-phase-1-60.mjs`. It checks that all 60 phases have
ordered evidence, that evidence files exist, and that the shared security
controls fail closed. A phase is not marked complete by the existence of a
static claim alone.

The repository implementation is complete. Phases 29, 30, and 50 also require
external evidence that cannot be created safely from this workspace:

- real staging database/cache/EventBus/OIDC/mail/Telegram/storage dependencies;
- multi-replica chaos, load, backup-restore, and rollback runs;
- live provider credentials, signature verification, and rotation drills;
- container registry provenance and deployment attestations.

These are recorded as explicit external gates in the manifest and certification
report. They are not silently converted to PASS.

## Shared controls

- `@ayzen/auth-client` provides purpose-bound, short-lived, single-use step-up
  tokens and service signatures bound to method, path, audience, and body.
- `@ayzen/service-runtime` rejects forged tenant headers and requires verified
  tenant scope for domain writes.
- `@ayzen/rate-limit` provides an atomic Postgres UPSERT limiter. Service and
  gateway runtimes refuse process-local limiting in staging or production.
- Vault refuses to start with an ephemeral master key.
- AI sensitive tools require a verified step-up token.
- Notification provider calls use signed requests, bounded timeouts, and a
  concurrency bulkhead; notification bodies cannot replace trusted tenant
  context.
- Workflow approval decisions require an authenticated approver with the
  approval capability or privileged role and an exact tenant match.
- EventBus NOOP and identity bypasses are local-development-only, while event
  signatures bind security-relevant envelope context.

## Validation

```text
pnpm install --frozen-lockfile
node scripts/validate-sota-phase-1-60.mjs
node --test tests/sota/sota-phase-1-60.test.mjs tests/security/step-up-token.test.mjs tests/security/tenant-scope.test.mjs
```

Rollback is a normal code checkpoint plus restoring the previous migration
ledger entry. No migration is required for the shared controls introduced in
this implementation; the rate-limit table is created idempotently by the
runtime and can be dropped only through an approved rollback procedure.