# AYZEN security boundary

## Boundary controls

- Public traffic enters through the API gateway or validated Telegram webhook.
- JWT verification is algorithm-pinned and uses RS256/JWKS key identifiers.
- Session revocation, refresh rotation, OIDC validation, MFA/passkeys, and
  login rate controls remain identity-owned.
- Workspace and organization IDs are resolved server-side; request headers are
  context hints, not authorization.
- Policy checks combine membership, role, resource ownership, bot capability,
  service identity, and step-up requirements.
- Internal service requests use HMAC signatures, timestamps, request IDs, and
  durable nonce replay protection.
- Vault and mailbox access is audited and tenant-scoped.

## Non-negotiable rules

Never log or return secrets, tokens, private keys, vault plaintext, raw
database errors, or stack traces. Never trust a client-supplied workspace or
Telegram identity without resolving it against authenticated server state.