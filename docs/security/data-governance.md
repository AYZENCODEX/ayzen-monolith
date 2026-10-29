# Data governance

## Classification

| Class | Examples | Required handling |
| --- | --- | --- |
| Public | Health status and non-sensitive service metadata | Safe to expose only through approved endpoints |
| Internal | Operational metrics and route mode | Access-controlled, no secrets or raw payloads |
| Confidential | User, workspace, finance, and mailbox records | Tenant isolation, least privilege, audited access |
| Restricted | Credentials, vault plaintext, private keys, session tokens | Secret manager/encryption, never log, rotate on exposure |

Services retain only the data they own. Cross-domain views use authorized APIs
or versioned events, never direct table reads. Deletion and export requests
must be scoped to the owning workspace and recorded in the audit trail.

Retention periods are deployment and legal inputs; do not invent a period in
application code. Expired data must be deleted or irreversibly anonymized
through an approved job with a dry-run and rollback plan.