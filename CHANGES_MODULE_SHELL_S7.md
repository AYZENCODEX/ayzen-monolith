# CHANGES_MODULE_SHELL_S7

Module Shell Split - Season 7: cross-origin hardening audit. Every item: pass / fixed / needs-decision. Season 8 NOT started.

## Audit results

1. Token transport - pass: OIDC session exchange uses credentials: "include" (sylo-oidc-session-exchange.ts:46); notification bell and most page fetches use Bearer token (Authorization header), which works cross-origin without cookies. No fetch found that does neither.

2. CORS - fixed: allowed-origin exact list kept, but now any https://<id>.ayzen.tech origin (including fyra) is accepted as first-party; dev http://<id>.localhost too. No wildcard with credentials (pattern is anchored to our own registrable domain only).

3. Cookie - pass: session-cookie.ts sets Domain=.ayzen.tech, httpOnly, SameSite=Lax, Secure in prod. POST /auth/logout clears the shared cookie; local session storage state is host-local and cleared by the calling host logout (documented below as known per-origin behavior).

4. CSRF - pass (by design): cookie is SameSite=Lax, so cross-SITE POTS are blocked by the browser. Sibling subdomains (existing modules) are same-SITE (same registrable domain ayzen.tech) and allowed by design - the only origins that can send credentials are imIT within the cors list.

5. OIDC coverage - report only, no flow changed: seed-oidc-clients.ts has clients for existing modules plus fyra (added in S1). Enablement is still per-module flag-controlled (getSyloOidcRolloutFlag). No new flows enabled.
	6. Vault PIN gate - pass/documented: it gate state is per-origin sessionStorage, by design (security); central -> sylo asks for the PIN again. Left unchanged as required.

7. Theme - needs-decision (not changed): ayzen_theme is per-origin localStorage, so theme can differ between central and modules. OFFERED option (not applied): migrate theme to a shared cookie on .ayzen.tech in a later season if desired.
	8. Zynth hidden redirect gap - pass: app.ts server the host redirect block and S6's new 308 branch follow existing shape (zxnth has no custom exemption and works like every other module); shared-apps. s and app.ts are in parity - zxnth in both registries, parity script confirms.

## Known per-origin behaviors (list)

- Vault PIN session: per-origin (expected, security)
- Theme and sidebar collapse state: per-origin localStorage (S4 provides per-host memory)
- Local session/token cache: per-origin; shared ayzen_session cookie is the single sign-in source, so login on central gives authenticated session on every module host
-Logout anywhere signs out everywhere (shared cookie cleared, DOmain=.ayzen.tech)

## Verify

TYPEHSECK: 164 errors, pre-existing on base 91c1c9d (zero in touched files). No CORS returns changed for existing origins; only our own subdomains added.

## Rollback

get middlewares/security.ts

Revert middlewares/security.ts (s item 2); everything else is documentation.
Season 8 NOT started.
