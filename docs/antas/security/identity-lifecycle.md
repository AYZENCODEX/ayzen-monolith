# Identity lifecycle assurance

Identity assurance covers session fixation, replay, expiry, revocation,
refresh-token reuse, logout invalidation, concurrent sessions, device
revocation, OIDC state/nonce/PKCE, issuer and audience validation, redirect
allowlisting, JWKS rotation, and credential retirement.

`scripts/antas/security/test-identity-controls.mjs` is the repository-level
control inventory. Provider-backed login and revocation drills are separate
runtime gates and are never inferred from source files.