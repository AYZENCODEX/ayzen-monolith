# Production operations

## Rollback

1. Disable the affected service URL environment variable.
2. Restart the gateway using the previously approved immutable image.
3. Confirm the route matrix points the family back to the monolith.
4. Stop writes only if the migration registry says dual-write cannot safely
   continue.
5. Restore data only after validating the backup and obtaining approval.

## Dependency outages

| Incident | First action | Safe behavior |
| --- | --- | --- |
| Database | Mark readiness false and protect writes | No fabricated success |
| Event bus | Pause publishing/consumers | Preserve outbox rows |
| Telegram | Pause webhook delivery | Keep update idempotency records |
| Mail provider | Pause delivery retries if provider is down | Preserve send queue |
| AI provider | Disable affected tool/model | No authorization bypass |
| WISP storage | Disable attachment access | Preserve metadata only |
| Identity | Keep existing sessions bounded by policy | Reject new privileged actions |