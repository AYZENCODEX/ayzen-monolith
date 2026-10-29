# Security incident response

## Severity

| Level | Example | Target action |
| --- | --- | --- |
| P0 | Credential exposure, cross-tenant data access, or active account takeover | Contain immediately, disable affected capability, page security owner |
| P1 | Privilege bypass, vault/mail leakage, or sustained provider abuse | Contain during the incident window and begin forensic review |
| P2 | Isolated suspicious activity or a control with a safe fallback | Triage, preserve evidence, and patch through normal release governance |

## First response

1. Preserve request IDs, audit records, deployment identifiers, and timestamps.
2. Do not copy secrets, tokens, vault plaintext, or personal data into tickets.
3. Disable the affected route, tool, provider, or credential using the smallest
   reversible scope.
4. Keep the monolith fallback or read-only mode where it is safe.
5. Rotate affected credentials through the secret manager.
6. Record containment, impact, notification, and recovery decisions.

## Closure

The incident owner confirms tenant impact, remediation, regression tests,
monitoring coverage, and a post-incident review before closing the record.