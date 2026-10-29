# Audit integrity

Critical actions record actor, target, action, outcome, policy decision,
tenant/workspace context, trace/correlation identifiers, and provenance. Audit
records are append-oriented and integrity-verifiable; secret values and raw
credentials are redacted before persistence or delivery.