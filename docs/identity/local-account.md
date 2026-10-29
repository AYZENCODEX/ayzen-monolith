# Local app accounts

Local account creation is app-scoped. The local account engine supports
verification, disablement, recovery state, profile ownership, and session
issuance without requiring an AYZEN account.

Credential hashing, passkeys, rate limits, and recovery transport remain
implemented by the identity/authentication boundary; the identity domain never
stores raw credentials or tokens.