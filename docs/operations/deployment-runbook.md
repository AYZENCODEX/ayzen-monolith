# Deployment runbook

1. Generate an immutable release manifest with
   `node scripts/release-manifest.mjs --service=monolith`.
2. Confirm frozen dependencies, typecheck, build, security, migration, and
   staging smoke gates.
3. Deploy the canary cohort using the promotion policy. Keep the gateway route
   fallback enabled.
4. Monitor error rate, latency, auth failures, policy denials, queue depth,
   dead letters, database health, external failures, and cost.
5. Promote only after the monitoring window is clean. If a gate regresses,
   follow `rollback-runbook.md`.