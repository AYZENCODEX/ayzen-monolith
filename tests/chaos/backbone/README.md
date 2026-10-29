# Backbone chaos evidence

Chaos scenarios cover dependency timeout, EventBus outage, duplicate delivery,
poison messages, worker loss, workflow cancellation, and replay recovery.
Every scenario must verify bounded recovery and audit output.

## Automated coverage

The two scenarios required by the EventBus roadmap's Phase A4 gate run as
real `node --test` integration tests against a live Redis, not as narrative
evidence:

- **Consumer killed mid-processing** (crash-recovery, no lost/duplicate
  delivery) — `packages/event-client/test/redis-bus-chaos.test.mjs`
- **Poison message quarantine** (DLQ after `maxAttempts`, not retried
  forever) — same file

CI runs these in the `eventbus-chaos` job in `.github/workflows/ci.yml`,
which starts a `redis:7-alpine` service container and sets `EVENT_BUS_URL`
before invoking `pnpm --filter @ayzen/event-client test`. Locally:

```sh
docker run -d --rm -p 6379:6379 redis:7-alpine
EVENT_BUS_URL=redis://localhost:6379 pnpm --filter @ayzen/event-client test
```

Without a reachable Redis the suite skips with an explicit reason instead of
reporting a false green.

Worker-loss and workflow-cancellation recovery are covered separately by
`packages/workflow/test/lease.test.mjs` (Phase B5's two-replicas-no-double-
execution gate), which runs against the in-memory store and needs no
external service.