---
name: Vault certification evidence boundary
description: How Vault modularization certification separates repository proof from deployment-specific proof.
---

The Vault modularization certificate may mark repository and static compatibility
gates as PASS, but it must keep provider-backed staging, production, destructive
restore, and sustained capacity results explicitly environment-dependent.

**Why:** Static files and validators cannot establish cloud-provider behavior,
real recovery objectives, or production traffic safety.

**How to apply:** Preserve the distinction in future evidence updates; add
deployment drill artifacts rather than weakening static gates or fabricating
runtime measurements.

For clean-copy tamper regeneration, resolve installed validator dependencies
from the workspace without copying `node_modules`. Ignore commit identity and
file-mtime metadata only in the clean-copy comparison; keep those fields covered
by the evidence ledger.

**Why:** The isolated copy intentionally has no `.git` directory and receives
new filesystem mtimes, so otherwise deterministic gates appear different even
when their substantive evidence is unchanged.

**How to apply:** Keep the ledger canonicalization stricter than regeneration
comparison, and treat any new ignored field as environment metadata only when
it cannot change the gate's substantive result.
