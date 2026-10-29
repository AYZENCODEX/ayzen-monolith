# Backbone rollout runbook

1. Validate schemas, contracts, policy, and circuit registration.
2. Run unit, negative-security, API, event, workflow, and isolation checks.
3. Promote infrastructure from development to staging before production.
4. Observe error rate, latency, queue age, consumer lag, dead letters, and
   workflow failures.
5. Roll back by disabling extracted route or consumer, not by creating a
   second writer.