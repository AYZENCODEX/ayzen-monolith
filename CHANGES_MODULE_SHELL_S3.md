# CHANGES_MODULE_SHELL_S3

Module Shell Split — Season 3: central sidebar - modules out, AYZEN apps item in (behind VITE_CENTRAL_LAUNCHER, default off). Season 4 NOT started.
One season, one phase; Season 3 NOT started.

## What changed

1. Reusable pieces of app-sidebar.tsx exported (behavior unchanged):
   - artifacts/ayzen/src/components/layout/app-sidebar.tsx
     - `export` added to: NavGroupComp, NavSectionComp, ProfileQuickAccess, SidebarAiPanel, AdminProjectsSidebarSection, filterGroupsBySubdomain, and the NavGroup interface.
     - New `useRoleNavGroups()` hook: the exact role-selection + useNavConfig DB merge + static-fallback logic AppSidebar used, now shared by both sidebars (no behavior change on central).
     - `NavGroup` interface is now `export interface NavGroup`.

2. New components/layout/module-sidebar.tsx — the dedicated module sidebar:
   - Header: module icon (S1 registry `icon` field when set) + label.
   - Pinned first item: `← AYZEN` — a plain `<a href={centralUrl("/")}>` (cross-origin full navigation; the shared `ayzen_session` cookie keeps the user signed in).
   - Body: role-based groups filtered by `app.routePrefixes` via the existing `filterGroupsBySubdomain`, rendered with the same NavGroupComp.
   - Footer: ProfileQuickAccess (its navigate is host-swapped via `moduleUrl(app.id, ...)` so profile links stay on the module host).
   - AI panel (SidebarAiPanel) renders on zynth only (default per roadmap).
   - AdminProjectsSidebarSection renders only when `app.id === "skarn"`.

3. AppSidebar is now a pure switch (no hooks in the switch itself, each branch owns its hook calls):
   - `getCurrentSubdomainApp()` non-null → `<ModuleSidebar app=... />`
   - otherwise → `CentralSidebar` (the previous AppSidebar body, byte-identical output).

4. app-layout.tsx: the mobile top bar title shows the module label on a module subdomain, "AYZEN" on central. Desktop/sidebar logo unchanged.

## Not touched
Central sidebar visuals (CentralSidebar body unchanged), routes, auth, vault-sidebar.tsx, enroll-sidebar.tsx, mobile-dock.tsx.

## How to verify
- Central domain (ayzen.tech / localhost): sidebar identical to before (CentralSidebar is the old body).
- Module host (e.g. sylo.localhost): sidebar shows only vault-scope nav for the signed-in role + `← AYZEN`; no central or other-module items (filterGroupsBySubdomain + module-only render). `← AYZEN` navigates to https://ayzen.tech still signed in (shared cookie).
- Sidebar Builder (useNavConfig) edits still flow into module nav (same merge hook).
- `pnpm --filter @workspace/ayzen typecheck`: 164 errors, all pre-existing on the base commit (same count as before this change; zero in touched files).
- `pnpm run build` (artifacts/ayzen): passes, 404.html fallback still produced.

## Rollback
Revert app-sidebar.tsx and app-layout.tsx; delete module-sidebar.tsx. Single commit.
