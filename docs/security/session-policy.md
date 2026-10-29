# App session policy

Sessions are app-scoped, device-aware, expiry-bound, revocable, and stored by
digest rather than raw token. Logout-all revokes every active session for the
local app identity. Tokens must not appear in logs or audit payloads.