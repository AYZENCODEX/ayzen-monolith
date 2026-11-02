# Phase 6 — module sidebar restructure (Sylo first)

- `components/layout/module-nav/` holds one layout config per module. `restructureModuleGroups()` dissolves the central wrapper group at render time; `ModuleSidebar` applies it AFTER `useRoleNavGroups()` + `filterGroupsBySubdomain()`, so role filtering (user/admin/dev/moderator/team leader), DB-driven nav overrides, plugin gates and the collapsed rail are unchanged. No nav rows or Sidebar Builder data are rewritten.
- Sylo: the "Vault" wrapper is removed; **Account, Access, Enroll, Other** are top-level sections ("Enrollment" renamed "Enroll"). A pinned **Hub** entry (`/vault/hub`) keeps the old wrapper header link reachable. Admin groups (`/admin/vault`, `/admin/team-vault`) are not touched.
- `NavGroup` gained an optional `pluginSlug`, honoured by `NavGroupComp`, so a plugin-gated section promoted to a group stays gated.
- Other modules keep their inherited sidebar until their section list is confirmed (add a file + one line in `module-nav/index.ts`).
- Tests: `api-server/src/lib/module-nav.test.ts`.

## Addendum — remaining modules (approved layouts)
- **Fyra:** `Finance` wrapper dissolved → Overview / Cash Flow / Loans / **Wealth** / Expenses / Accounting / Invoices / Reports. Wealth merges Investments + Assets + Goals (Assets' lone "Overview" link is shown as "Assets Overview").
- **Verve:** Hub (pinned) / Market (Official, P2P, Vault Market + Polymarket folders kept nested) / Wallet (Market Wallet) / Orders (Order History).
- **Skarn:** `Protocols` → Projects (Project + the Category tree, nested) / Tasks / Content. In the central nav the "Task" link sits INSIDE the Category section; the config pulls it out into Tasks. The existing Instant/Other duplicates are left as they were. Admin "Protocols" untouched.
- **Warde:** `Team` → Overview / Progress / Finance / Panel (team admin Panel is separate from module Settings).
- **Wisp (B2):** `Social` → **Mailbox** (AYZEN Mail) + **Accounts** (Email Accounts `/email-accounts`, AYZEN Email setup `/ayzen-email`; both already routed and inside Wisp's route prefixes, links not duplicated if the DB-driven nav already has them).
- **Zynth:** `Social` → **Assistant** (rename only).
- **Ryft:** unchanged (single "Wallet" link).
- `ModuleNavConfig` gained optional `build` (full control, keeps nesting), `leafSection`, `postProcess`; `order`/`fallbackSection` are now optional. New `module-nav/helpers.ts`.
- Tests: `module-nav-modules.test.ts` (fixtures + source-shape guards that fail if the central USER_NAV drifts). Also verified against the real `USER_NAV` by evaluating it and running each config.
