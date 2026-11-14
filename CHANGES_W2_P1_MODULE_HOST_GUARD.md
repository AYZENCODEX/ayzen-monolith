# CHANGES — W2-P1: server-side module guard (req 4)

Before: `shared-apps.ts` only mapped host -> module and "does not perform authentication or authorization", so a page on one module's host could call another module's API path and the server did not care. Now the server refuses.

## What was added
| Piece | Where |
|---|---|
| Pure decision (`decideModuleHostAccess`, `pathCandidates`, `MODULE_HOST_ALLOWED_PREFIXES`) | `packages/module-registry/src/index.mjs` (+ `.d.mts`) |
| Mode switch, registered-origin check, frame-ancestors value | `lib/module-host-guard-core.ts` (pure, install-free) |
| Middlewares `moduleHostApiGuard`, `moduleHostPageGuard`, `moduleHostHeaders` | `lib/module-host-guard.ts`, mounted in `app.ts` |
| Per-module CORS allow-list | `middlewares/security.ts` |
| CI check (blocking) with 23-mutant self-test | `scripts/check-module-isolation.mjs` |
| Tests | `lib/module-host-guard.test.ts` (10) |
| Docs | `docs/identity-boundaries.md` (new section) |

## Behavior
`MODULE_HOST_GUARD_MODE` = `off` (default, nothing changes) | `report` (log only) | `owned` | `strict`. See the docs section for the table.
* A request acting for module M (first-party Origin, else Host) gets the **same 404 body as an unknown endpoint** on any path another module owns, so existence is not revealed. API paths (relative to `/api`) and page paths on a module host are both covered.
* Allow-list always reachable: `/auth /oidc /.well-known /health /connector`.
* Paths are judged under every spelling: lower-cased raw, plus percent-decoded once, `//` collapsed, `.`/`..` resolved. Bad escapes/NUL/backslash are refused. `/FINANCE`, `/%66inance`, `/vault/../finance`, `/auth/../finance` all stay denied.
* `owned`/`strict` also: CORS accepts a production first-party origin only if it is a registered host (module, role, central, API, MCP, OIDC issuer, `MODULE_CORS_EXTRA_HOSTS`; `ALLOWED_ORIGINS` still wins), and module hosts get `Content-Security-Policy: frame-ancestors 'self'` (+ `MODULE_FRAME_ANCESTORS_EXTRA`) and `Referrer-Policy: no-referrer`.
* Rollout: `report` first, read `module_host_guard.would_deny` logs, then `owned`. Kill switch: `off`.

## Deviations / limits (read these)
1. **The roadmap's "routePrefixes baire hole 404" is only available as `strict`, and strict is not recommended yet.** 672 of 1235 registered endpoints belong to no module prefix (`/admin` 209, `/users`, `/notifications`, `/vault-shares`, `/kyc-*`, ...). Strict would 404 shared platform APIs and several module-specific ones. `owned` implements the isolation guarantee (done criterion: another module's path = 404) without that breakage. Completing route ownership in the registry is the prerequisite for strict; the check prints the coverage numbers on every run.
2. **Defence in depth, not authentication.** A caller with no `Origin` (curl, server-to-server) is not "acting for a module" and is not touched; a non-browser client can also spoof `Origin`. Authentication and authorization still decide who may call what.
3. `Referrer-Policy` was already `no-referrer` through helmet; it is now set explicitly per module host and pinned by the check.
4. Host/Origin routing and CORS rely on registered hosts: `id.ayzen.tech` is accepted only when `AYZEN_OIDC_ISSUER` is set to it (otherwise add it to `MODULE_CORS_EXTRA_HOSTS`).

## Verified / not verified
Verified: 10 unit tests, the 12-rule isolation check incl. the full module x prefix matrix, 23/23 mutants caught, types of the pure files, earlier suites still green.
Not verified: the Express middleware wiring at runtime (express is not installable here; only checked statically), CSP/CORS behavior in a real browser, and report-mode logs against real traffic.
