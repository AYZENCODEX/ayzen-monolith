# CHANGES_MODULE_SHELL_S8

Module Shell Split - Season 8: QA matrix, rollout, cleanup. Season 8 is the last season in the roadmap (no Season 9 exists).

## 1. QA matrix

Full matrix at docs/module-shell-qa.md --8  modules x 4 roles x desktop/mobile: sidebar contents, back link, collapse, cross-module link, public link. Cells are static analysis (pass / known issue); browser smoke tests cannot be run in this sandbox -- honestly noted there.

## 2. What ran (honest)

- TYPECHECK: 164 pre-existing errors (base 91c1c9d), zero new
- parity script: OK (8 modules, prefixes unique)
- vite build: pass
- e2L/smoke/unit tests in repo: no published set for this surface; not run

## 3. Rollout order (documented)

1. VITE_CENTRAL_LAUNCHER=1 (launcher)
2. VITE_SPLIT_REDIRECT_MODULES one module at a time: sylo, skarn, warde, wisp, ryft, fyra, verve, zxnth (smoke check between each)
3. SPLIT_REDIRECTS=1 server side once client stable

## 4. Flags after stable use

- true cleanup: remove VITE_CENTRAL_LAUNCHER and old central nav path -- scheduled FRONTX pass, not done today (cleanup happens ATER stable use, the docs state so)
- kill switch KEPT: VITE_SPLIT_REDIRECTS and SPLIT_REDIRECT_MODULES
	5. Parity script is now BLOCKING in CI definetively:348 continue-on-error: true -- suit for the experimental pass; parent job now blocks on drift.
	6. replit.md -- Season Structure added.
## Stable use

Rollout fRIENDLY -- true cleanup pass after the central launcher has been on for a while in production.
## Rollback

setting flags off returns to the completely unchanged S4 behavior; no code changes needed.
