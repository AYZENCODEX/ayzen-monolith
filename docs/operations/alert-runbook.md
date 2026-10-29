# Alert runbook

Alerts route through the configured notification policy and are deduplicated
by alert identity and cooldown. An operator should be able to detect,
investigate, act, acknowledge, and audit an incident.

For every alert:

1. Capture the alert fingerprint, release identifier, and correlation IDs.
2. Check `/ready`, latency, error rate, queue depth, and dead letters.
3. Identify the dependency or route family before taking action.
4. Acknowledge only after an owner and next action are recorded.
5. Escalate when the cooldown expires without recovery.
6. Close with a linked audit record and evidence report.