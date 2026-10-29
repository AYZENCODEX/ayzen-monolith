# Production go-live checklist

An authorized release owner must mark every item complete before enabling
production traffic.

## Build and security

- [ ] Immutable image/source identifiers recorded.
- [ ] Frozen dependency install, typecheck, build, contract, security, and
      container scans passed.
- [ ] No credentials, private keys, vault values, or raw tokens in logs or
      artifacts.
- [ ] Secret rotation owner and emergency revocation path confirmed.

## Data and migration

- [ ] Backup and restore point recorded.
- [ ] Schema migration reviewed and rehearsed.
- [ ] Backfill counts/checksums validated.
- [ ] Route fallback and write rollback tested.

## Operations

- [ ] `/live`, `/ready`, and `/metrics` are scraped and alerting.
- [ ] Dashboards show latency, errors, dependency health, queue depth, and
      dead letters.
- [ ] On-call owner has access to `docs/operations/production-runbook.md`.
- [ ] Database, event bus, mail, identity, storage, and AI outage drills have
      an owner and a recorded result.

## Approval

Record the release identifier, rollout cohort, approver, start time, monitoring
window, and rollback decision owner. A checklist is not approval until those
fields are filled by the deployment owner.