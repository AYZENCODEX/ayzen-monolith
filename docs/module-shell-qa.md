# Module Shell QA matrix

Static analysis of the shipped code (S1-S7). Browser smoke tests were NOT runnable in the build sandbox; run each cell manually at rollout. Legend: P = pass by construction, KNOWN = known per-origin behavior.

Modules: sylo, skarn, warde, wisp, ryft, fyra, verve, zynth
Roles: user, admin, moderator, team_leader
Surfaces: desktop, mobile (Sheet drawer, no rail; no bottom dock since W2-P3)

Per module x role (all 8 x 4):
- Sidebar contents: module-only nav (filterGroupsBySubdomain over role groups; DB-driven useNavConfig merges first, static arrays fallback) - P
- Back link: "<- AYZEN" plain anchor to centralUrl("/") - P
- Collapse: 4rem icon rail desktop, per-module localStorage, [ shortcut - P; mobile no rail - P
- Cross-module link: ModuleLink/module-aware go() full-navigates to the target subdomain (wisp mail shortcuts, search results; the mobile dock was removed in W2-P3) - P; page-level links partly pending (82, listed in CHANGES_MODULE_SHELL_S5.md) - KNOWN
- Public link: ALWAYS_ALLOWED_PREFIXES render on any host, never redirected (S6) - P

Central (ayzen.tech) x role:
- Launcher: AppsMenu behind VITE_CENTRAL_LAUNCHER=1, module groups filtered out - P
- Flag off: sidebar identical to pre-split - P
- Redirects: W2-P2 retired the client-side VITE_SPLIT_REDIRECTS / VITE_SPLIT_REDIRECT_MODULES flags. Central -> module forwarding is the server-side 308 (SPLIT_REDIRECTS / SPLIT_REDIRECT_MODULES), public/token pages exempt - P

Not runnable here: real login flows, cookie handoff across live hosts, CORS from a deployed module. Verify during rollout smoke checks.
