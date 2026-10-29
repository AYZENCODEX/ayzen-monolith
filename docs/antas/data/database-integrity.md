# Data isolation and database integrity

Database ownership is recorded separately from application identity. Every
migration must describe forward and rollback behavior, compatibility, lock
impact, data-loss risk, backfill, and verification. Tenant scope must be
enforced for reads, writes, search, exports, downloads, restores, webhooks,
and workers.

Provider-managed schemas and real tenant isolation require a connected staging
database; source evidence alone is not a production proof.