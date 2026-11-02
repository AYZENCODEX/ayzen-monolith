# Telegram Phase 5 — per-module Settings pages + Telegram card

- New pages (one component, `pages/user/module-settings.tsx`) at `/vault/settings` (Sylo), `/wallet/settings` (Ryft), `/finance/settings` (Fyra), `/marketplace/settings` (Verve), `/projects/settings` (Skarn), `/teams/settings` (Warde), `/mailbox/settings` (Wisp), `/assistant/settings` (Zynth). Each is inside its module's existing `routePrefixes` (both `shared-apps.ts` and `subdomain-app.ts`), so the subdomain redirect does not bounce it. The module is resolved from the path, so it also works on the central domain.
- Routes are registered in `route-config.tsx` before every `/<module>/:param` route (`/projects/:id`, `/mailbox/:id`).
- `ModuleSidebar` shows a Settings link pinned at the bottom of every module sidebar (works in collapsed-rail mode).
- `components/telegram/module-telegram-card.tsx` (botKey == module id), backed by the Phase 4 endpoints: Connect (deep link + code, polls until the bot claims it), "I have a code" (bot `/connect` flow), Active/Paused switch (optimistic, rolls back on error), last activity, Disconnect. Shows a clear message when the bot token is not configured.
- `lib/module-settings.ts` is the path map. Guard test: `api-server/src/lib/module-settings-paths.test.ts` (paths inside prefixes on both sides, bot key exists, route order, sidebar link).
- `frontend-registry.json` regenerated (`node tools/ui-circuit-validator/build.mjs`): only the 8 new routes plus counters.

Not in this phase: admin-side module settings under `/admin/...` (roadmap section 3, last bullet), and the sidebar restructure (Phase 6).
Pre-existing, untouched: 3 TS errors in `pages/admin/projects.tsx` (`authHeaders` undefined).
