# Integration enforcement runbook

The integration graph is the source of truth for approved edges. Unknown,
unhealthy, contractless, unaudited or unrecoverable critical edges are
quarantined. Runtime quarantine is fail-closed and emits an audit record.

Use the validator to identify the exact finding code. Repair the registry or
contract, rerun the gate, and only then request an operator-approved
dequarantine. Auto-remediation is intentionally disabled.