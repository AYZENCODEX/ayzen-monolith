---
name: Supabase schema isolation
description: Environment-specific guidance for Drizzle schema operations in this workspace.
---

When the database includes provider-managed schemas such as `auth`, `realtime`, `storage`, or `vault`, Drizzle schema operations must be scoped to the application's `public` schema.

**Why:** Unscoped introspection treats provider-owned tables as rename candidates for application tables and can block a non-destructive development schema setup.

**How to apply:** Keep the Drizzle config's public-only schema filter in place. Never use a force push against this database just to bypass the provider-schema conflict; inspect the diff and apply only authorized additive changes.

Do not assume Drizzle's configured `tablesFilter` limits the tables changed by `drizzle-kit push`. In this workspace a purported Finance-only push applied the full application schema to the Replit development database.

**Why:** The push changed more schema than intended; the existing rate-limit table remained and no data backfill ran, but the test database acquired the complete application schema.

**How to apply:** Keep broad pushes blocked for test targets. Before any schema write, inspect the target and generated diff; afterward, inventory actual tables. Prefer reviewed, explicitly scoped migrations or fixtures for test setup.