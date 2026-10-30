# CHANGES_MODULE_SHELL_S5

Module Shell Split - Season 5: cross-module links (ModuleLink). One season, one phase; Season 6 NOT started.

## Inventory (grep at start)

87 hardcoded cross-module-candidate links across 30+ files (roadmap grep run on artifacts/ayzen/src).

## Shared components fixed (this pass)

New artifacts/ayzen/src/components/module-link.tsx: ModuleLink (wouter Link when same module or central-only-on-central, plain anchor to moduleUrl(id, href) across origins; query and hash preserved verbatim), useModuleNavigate() (window.location.assign across origins), moduleLinkProps(), isCrossModule().
- app-layout.tsx: Open Full Mailbox routes to wisp /mailbox from any non-wisp host.
- app-sidebar.tsx: the AtSign AYZEN Mail shortcut routes to wisp /mailbox from any non-wisp host.
- mobile-dock.tsx: every dock tab resolves through getModuleForPath; cross-module tabs full-navigate to the module subdomain, same-module and central-only tabs stay client-side.
- global-search.tsx and command-search.csx: shared go()/navigate made module-aware; cross-module results (vault entity/local/2fa/mail-hub, finance dashboard, projects) full-navigate to their subdomain.

## Remaining page-level links (documented exceptions list, per roadmap)

82 page-level links in 30 files left for a follow-up batch pass (roadmap allows: shared components first, list the rest). Files: pages/user vault-enrolment*, vault-2fa*, vault-backup*, vault-activity, project-*, teams, dashboard, mailbox, airdrop-calendar, ayzen-email, marketplace-*, finance/investment-detail; components kyc-entries, local-accounts, vault/linked-entities-section, vault/vault-auth; pages/login, pages/finance/invoice-public, App.tsx. Same-module links intentionally unchanged.

## Verify

Typecheck: 164 errors, all pre-existing on base 91c1c9d; zero in touched files. Vite build passes. Route paths and page logic untouched.

## Rollback

ModuleLink is drop-in; revert per file.
