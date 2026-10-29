# API and release governance

## Compatibility

- Public clients use the gateway and versioned public paths.
- Internal service URLs are never part of a client contract.
- Additive response fields are backward-compatible; removing or changing the
  meaning of a field requires a new version or a documented migration window.
- Event envelopes keep their schema version while old consumers remain live.
- Every route cutover has a monolith fallback until validation is complete.

## Release record

Each release must record:

1. immutable source/image identifier;
2. database and event schema changes;
3. migration owner and backup/restore point;
4. contract and security test results;
5. rollout cohort and monitoring window;
6. rollback switch and decision owner.

Do not enable an extracted route by setting an environment variable alone.