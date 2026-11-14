# ADR W1-P3: which host is the OIDC issuer

Status: **DECIDED 2026-11-11: `https://id.ayzen.tech` approved by the owner.** The rollout below is not done yet; until it is, nothing here changes production behaviour: the code still resolves the
issuer exactly as before (`AYZEN_OIDC_ISSUER`, else `APP_URL`, i.e. `https://ayzen.tech`). This records the options and
the recommendation so the owner can decide, and lists what a flip must do. Roadmap source: W1-P3 ("Issuer host fix
(A8-adjacent decision: `https://api.ayzen.tech` ba `https://id.ayzen.tech`)").

## What the issuer is bound to

The issuer string is the ID token `iss`, the `issuer` and every endpoint URL in the discovery document, and each relying
party's configuration (modules read it from their OIDC client config; `test-oidc-backchannel-logout-receive.ts` pins it).
It is effectively permanent: changing it later breaks every issued token's `iss` check and every RP config at once.

## Options

| | `https://ayzen.tech` (today) | `https://api.ayzen.tech` | `https://id.ayzen.tech` (recommended) |
|---|---|---|---|
| Already serves discovery/OIDC | yes (central app host) | yes (same server) | needs DNS + TLS + gateway host rule |
| Cookie / CSP / CORS posture | the product SPA's: wide | the API's: cross-origin `fetch` from every module, Origin-derived module context (W1-P2) | dedicated: nothing but IdP routes, no SPA, no module Origin logic |
| Role-host / module-host gates | central host is in `CENTRAL_HOSTS`; page gate skips `/oidc` anyway | API-host MCP shim sits on this host (mounted after OIDC, so no shadowing) | no gate applies |
| User-facing hops | authorize UI is already on this host | browser lands on an API hostname during login | clean; authorize redirects to the login SPA |
| Conflates IdP with | the product app | the data API and MCP | nothing |

## Recommendation

Use **`https://id.ayzen.tech`** as the issuer (approved), because the issuer is permanent and `id.` is the only option
that does not couple the IdP to another surface's CORS, cookie and rate-limit policy. **Do not flip it before:**

1. DNS + certificate for `id.ayzen.tech`, and the gateway forwarding `/oidc`, `/.well-known` to the identity service
   (the route table already does this host-independently; verified by `test-oidc-conformance.ts` block 4).
2. `AYZEN_OIDC_ISSUER=https://id.ayzen.tech` set on the API **and** every relying party (Sylo cutover config, the eight
   module clients) in the same release, with a window where RPs accept both issuers; ID tokens issued before the flip carry the old `iss`.
3. The central session cookie (`COOKIE_DOMAIN`) covering `id.ayzen.tech`, since `/oidc/authorize` reads the shared
   AYZEN session. Module `__Host-` cookies (W1-P2) are deliberately never sent to `id.`; that is correct.
4. `node scripts/smoke-oidc-endpoints.mjs https://id.ayzen.tech` passing, then the Sylo OIDC rollback drill.

Until then keep today's value. If the owner picks `api.ayzen.tech` instead, the same four steps apply except 1 (no new DNS).

## Added in W1-P4: login/signup/consent redirects on a dedicated issuer host

`/oidc/authorize` used to build its `/login` and consent redirects from the request host. On `id.ayzen.tech` (no SPA) that
would 404, so `lib/oidc-central-origin.ts` now sends those redirects to `APP_URL` when, and only when, the request arrived on a
dedicated issuer host. With the issuer on the app host (today) nothing changes. Step 3 above (cookie domain) still applies.

## What W1-P3 shipped in code regardless of the decision

- `issuerProblem()` + a boot-time `oidc.issuer.invalid` error log if `AYZEN_OIDC_ISSUER`/`APP_URL` is malformed.
- Conformance test proving that for `ayzen.tech`, `api.ayzen.tech` and `id.ayzen.tech` every advertised URL is built on the chosen host.
- `smoke-oidc-endpoints.mjs` to verify a live host (including `--issuer-differs` for gateway setups).

| Decision | **`https://id.ayzen.tech`**, approved 2026-11-11. Activation = set `AYZEN_OIDC_ISSUER` per the four steps above (code default intentionally unchanged until DNS/TLS and RP config are ready). |
|---|---|
