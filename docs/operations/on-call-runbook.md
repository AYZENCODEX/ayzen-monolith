# On-call runbook

The on-call owner needs access to this runbook, the production runbook, the
deployment dashboard, audit explorer, release manifest, and incident log.

Escalation order:

1. Service owner for the failing route or dependency.
2. Platform owner for gateway, event bus, worker, or deployment failures.
3. Security owner for auth, policy, tenant isolation, or secret exposure.
4. Release owner for rollback or launch decisions.

Every incident gets an identifier, owner, severity, timeline, decision log,
linked evidence, and a follow-up review.