# CHANGES — W2-P3: remove the mobile bottom dock (req 5)

## What changed
* `components/layout/mobile-dock.tsx` deleted (Home / Projects / Market / Vault / Teams tabs, `fixed bottom-0 ... md:hidden`).
* `components/layout/app-layout.tsx`: the dock is no longer rendered; the `pb-24 md:pb-8` padding that reserved room for it is now `pb-8`.
* The mobile navigation is the drawer that already existed (`Sheet` + `AppSidebar`, which renders `ModuleSidebar` on a module host). It is now the *only* mobile navigation, so it got the accessibility it was missing: the hamburger has `aria-label="Open navigation menu"` + `aria-expanded`, the drawer has a screen-reader title/description, and both carry `data-testid`s for tests. It still closes on navigate (`onNavigate`).
* ADR Q4 ("remove only Home/Market/Vault tabs or the whole dock?") is still pending the owner's answer; the plan's default (whole dock) is implemented and recorded in `ADR-W0-FREEZE.md`. If the answer is "keep Projects/Teams", restore the file from git history and cut it down to those tabs.
* `docs/module-shell-qa.md` no longer lists dock tabs.

## Proof
| Check | What it proves |
|---|---|
| `scripts/validate-w2-p3.mjs` (+`--self-test`, 14 mutants) | dock file gone and unreferenced, no other full-width fixed bottom bar anywhere in the SPA, no reserved dock padding, drawer wiring + a11y, module nav inside the drawer, docs, CI |
| `tests/e2e/mobile-nav/mobile-no-dock.spec.mjs` | the roadmap's "mobile viewport screenshot test": at 375, 412 and 767 px it asserts no fixed bottom bar, the hamburger opens the drawer (links inside), Escape closes it, no horizontal overflow, and saves closed/open screenshots. Needs `E2E_BASE_URL` + `E2E_TOKEN`; without them it prints SKIPPED |
| `... --self-test` | runs the same assertions in real chromium against two fixture pages: the old dock layout FAILS, the drawer-only layout PASSES. CI job `mobile-nav` runs it |

## Verified / not verified
Verified: the validator and its mutants; the viewport spec's detector in real chromium against fixtures (dock layout detected, drawer-only layout clean, screenshots written).
**Not verified:** the real app. The SPA cannot be built here, so the viewport spec has not run against the real AppLayout, and the screenshots I looked at are of the fixtures, not the product. Run it once against a deployed/preview build: `E2E_BASE_URL=... E2E_TOKEN=... node tests/e2e/mobile-nav/mobile-no-dock.spec.mjs`.

## Behavior note
On phones, people who used the dock to hop between modules now open the drawer (central drawer: all groups; module host: that module's nav plus the "AYZEN" link back to central). The desktop UI is untouched.
