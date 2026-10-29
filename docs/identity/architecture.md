# Hybrid app identity architecture

Each AYZEN app supports two independent entry modes:

- `local-app`: an app-owned account that does not require an AYZEN account.
- `ayzen`: a verified centralized identity.
- `connected-app`: a local app identity with an explicit active link to a
  verified AYZEN identity.

An email or username match is never sufficient to link accounts. The target
app owns local identity, profile, session, link, and authorization records.
The centralized provider owns AYZEN identity claims. The executable domain
contract is in `packages/identity/src/index.mjs`.

The final identity circuit is recorded in
`infrastructure/platform/hybrid-identity-manifest.json`.