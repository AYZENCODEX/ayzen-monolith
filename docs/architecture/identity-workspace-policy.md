# Identity, workspace, and policy foundation

Phases 4–6 are implemented in the modular monolith:

- Identity owns authentication, JWT/JWKS, sessions, OIDC, recovery, MFA, and
  passkeys.
- Workspace resolves personal and organization contexts and membership.
- Authorization evaluates role, ownership, resource, bot, service, risk, and
  step-up policy.

The extraction contract is intentionally verification-based: a downstream
service validates the signed token and local policy context, rather than
querying the identity database on every request. The API gateway parses
transport metadata only; it never authorizes a workspace from a header.