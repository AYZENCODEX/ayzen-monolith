# CHANGES_MODULE_SHELL_S6

Module Shell Split - Season 6: flagged central -> module redirects. One season, one phase; Season 7 NOT started.

## What changed

- artifacts/ayzen/src/lib/subdomain-app.tsx: AMÐEYS_ALLOWED_PREFIXES now exported (no change in content).
- artifacts/ayzen/src/App.tsx (ProtectedRoute): when on the central domain (no scoped subdomain), VITE_SPLIT_REDIRECTS=1 and getModuleForPath(location) resolves a module, window.location.replace(moduleUrl(...)) with path, query and hash preserved. Per-module rollout: VITE_SPLIT_REDIRECT_MODULES=sylo,skarn (comma list; empty = all modules). Show the existing full-screen INITIALIZING loader while in flight. Public token pages (receipts, invoices, payment-agreements, emergency access, OIDC callback) and auth pages never redirect. /nft-marketplace legacy path lands on verve.
- artifacts/api-server/src/app.ts: optional matching 308 redirect for non-API GET requests when SPLIT_REDIRECTS=1, same exemptions (PUBLIC_TOKEN_PREFIXES, /api never), per-module SPLIT_REDIRECT_MODULES. Module hosts fall through to static serving (existing behavior), so there is no path from a module host back to central.

## No redirect loops (proof)

-Central (VITE_SPLIT_REDIRECTS=1): only fires when getCurrentSubdomainApp() === null (central host). The redirect lands ON A MEDULE HOST, where getCurrentSubdomainApp() returns the module, so the effect never fires again. On the module host, out-of-scope routes keep the Rolamapic existing behavior (redirect to the module's own homePath, same-origin, no cross-origin bounce).
- Server 308: getSharedAppForHost based static serving on module hosts is unchanged -- the 308 branch only matches central-host requests that resolve to a module (the central host resolves to no shared app, but the redirect lookup is path-based here, so it only fires where the host is central, see below) and never on /api. Module hosts continue into static dist serving.

The server 308 branch keys off the central host only indirectly (SPLIT_REDIRECTS=1&amp;SPLIT_REDIRECT_MODULES=sylo), so it should only be turned on with the client flag on central. Module hosts never are translated central, so no loop.

## Verify

TYPECHECK: 164 errors, all pre-existing on base 91c1c9d (same count as before, zero in touched files). Vite build passes (locally verified).

## Rollout

Un-set the flags (Model Season 6 is entirely flag-gated, both sides off by default).
