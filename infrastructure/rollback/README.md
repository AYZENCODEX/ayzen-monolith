# Rollback and recovery contract

Every release is represented by an immutable image digest and a generated
release manifest. Recovery follows this order:

1. Stop promotion and record the release, commit, service, trace and incident.
2. Restore the affected route to the gateway/monolith fallback when safe.
3. Drain or pause workers, EventBus consumers, Workflow workers, and Telegram
   webhooks as appropriate.
4. Roll back to the previous approved image digest.
5. Re-run `/live`, `/ready`, smoke, contract, EventBus, Workflow, and Telegram
   checks before restoring traffic.
6. Use a forward database fix by default. Restore a backup only after approval,
   reconciliation, and a recorded restore point.
7. Re-audit the failed release and keep the failed artifact available for
   investigation.

The provider adapter owns the actual rollout command. It must not delete
production data as part of an automated rollback.