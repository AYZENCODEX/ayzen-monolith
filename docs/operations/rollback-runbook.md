# Rollback runbook

Rollback has two independent decisions: application traffic and data state.

1. Freeze the rollout and record the immutable release identifier.
2. Route the affected service family back to its previous image or monolith
   fallback using the deployment promotion policy.
3. Drain workers before terminating them; allow in-flight idempotent work to
   finish or move it to the dead-letter path.
4. Do not reverse a destructive migration automatically. Use the migration
   runbook's forward-fix or restore an isolated copy and compare checksums.
5. Verify `/live`, `/ready`, error rate, queue depth, dead letters, and critical
   journeys before reopening traffic.
6. Record approver, rollback owner, reason, timestamps, and verification output
   in the release evidence.