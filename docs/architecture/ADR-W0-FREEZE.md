# ADR freeze: Wave 0 (W0-P2)

Status: **PROPOSED, awaiting owner sign-off.** Source: `AYZEN Monolith: Audit + Full Roadmap` (2026-11-04), sections 4 and 9.
Nothing in Waves 1+ should start on an ADR that is still "Proposed". Sign-off = fill the **Decision** column and set the date.

## Architecture decisions

| ADR | Decision area | Recommendation (from audit) | Decision | Wave(s) it gates |
|-----|---------------|-----------------------------|----------|------------------|
| A1 | Module ID format | `<PREFIX>-<6 digit>` e.g. `SYL-000001`. Prefixes: SYL, SKR, WRD, WSP, RFT, FYR, VRV, ZYN. Internal FKs stay integers; the ID is for display/lookup. | _pending_ (W1-P1 implemented with this default) | W1-P1 |
| A2 | Module credential model | `module_accounts` + `module_credentials` + `module_account_links`. | _pending_ (W1-P2 implemented with this default) | W1-P2 |
| A3 | Clerk topology | One Clerk app per module (8) + 1 AYZEN. Only AYZEN OIDC is shared. Accepts cost and vendor lock-in. | _pending_ (see Q2) (W1-P5 implemented with this default: 8 module pools; AYZEN accounts stay in the first-party OIDC provider, not in Clerk. See `docs/identity-boundaries.md`) | W1-P5 |
| A4 | Session | Per-module host-only cookie `__Host-<module>_sid`; retire the shared `*.ayzen.tech` cookie. | _pending_ (W1-P2 adds the per-module cookie + dual-accept; retiring the shared cookie is W2-P1) | W1-P2, W2-P1 |
| A5 | Build | One codebase, per-module build entry (`VITE_MODULE`), separate deploys. | _pending_ | W2-P2 |
| A6 | MCP hierarchy | Namespaced tools + meta-tools + per-module endpoint `/mcp/<module>`. | _pending_ | W3-P3/P4 |
| A7 | Permission model | Cloudflare-style policy: zone (module id or `*`) x access (read/write). | _pending_ | W3-P2 |
| A8 | Self-hosted infra | Dedicated VPS / k8s cluster. Replit/Render are not suitable for Plane, Zulip, Langfuse, Bitcoin Core. | _pending_ (see Q7) | Wave 5 |

## Open questions (audit section 9)

| Q | Question | Audit default / note | Answer |
|---|----------|----------------------|--------|
| Q1 | ID format: `SYL-000001` (6 digit) or `SYL-01` style? | Short style runs out at 99 users. | _pending_ |
| Q2 | 8 separate Clerk apps (full isolation, more cost) or 1 app + module metadata? | Requirements were read as 8 apps. | _pending_ |
| Q3 | Open mail send / wallet transfer / finance write via MCP? | If yes: confirm token + `mcp-sensitive` scope + `dry_run`. Currently closed by design. | _pending_ |
| Q4 | Remove only Home/Market/Vault tabs or delete the whole mobile dock? | Plan assumes whole dock deleted. | _pending_ (W2-P3 implemented with this default: whole dock deleted; mobile navigation is the drawer) |
| Q5 | `ayzen.tech/api`: proxy, or 308 redirect to `api.ayzen.tech`? | Audit recommends proxy + deprecation header. | _pending_ |
| Q6 | Is Exchange a 9th module (own host, prefix `EXC`, landing, login)? | Affects registry size (W0-P3 is built for 8; adding one is a single registry entry). | _pending_ |
| Q7 | Where do self-hosted tools run (Hetzner / DigitalOcean VPS, k8s)? Budget? | Bitcoin Core needs hundreds of GB unless pruned. | _pending_ |
| Q8 | MCP tool count: >=100 total in M1, 30-40 per module in M2? | Reading of requirement 3 vs 9. | _pending_ |

## Notes carried from W0-P3

- The registry (`packages/module-registry`) already reserves `uidPrefix` (A1), `clerkApp` (A3), `oidcClientId` and `mcpEndpoint` (A6). Changing an ADR answer means editing that one file.
- Q6: adding a 9th module requires one registry entry plus `seedClient(...)` in `scripts/src/seed-oidc-clients.ts` and a Telegram bot key; `pnpm validate:module-registry` enforces all three.
