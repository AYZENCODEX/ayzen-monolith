# ADR-001: Event and service boundaries

## Decision

AYZEN keeps the compatibility monolith as the source of behavior while
extracting meaningful domains behind the gateway. Transactional domain changes
publish versioned events through the durable outbox. Services do not share
tables or import the monolith.

## Rationale

This supports incremental migration, replay, failure recovery, and rollback
without a big-bang rewrite. A route is not considered extracted merely because
an HTTP process exists.

## Consequences

Every extraction needs an owned schema adapter, authorization checks,
characterization and contract tests, observability, a backfill/validation plan,
and a reversible gateway switch.