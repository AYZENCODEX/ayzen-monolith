# PRJ-02 differential test (dates)

Runs the ORIGINAL `routes/project-dates.ts` and the current adapter against the same
in-memory fake DB and the same 30 HTTP requests, and compares status, body, log lines
and resulting rows. Not part of CI (needs `express@4` and `esbuild`, which are not
dependencies of this repo); run it by hand when touching the dates module.

```sh
mkdir /tmp/diff && cp scripts/antas/projects/differential/*.mjs /tmp/diff && cd /tmp/diff
npm init -y && npm i express@4.21.2 esbuild@0.24.0
ORIG=<path to the pre-PRJ-02 routes/project-dates.ts>      # from the original upload
NEW=<repo>/artifacts/api-server/src/routes/project-dates.ts
printf 'export { default } from "%s";\nexport { state } from "/tmp/diff/stubs.mjs";\n' "$ORIG" > wold.ts
printf 'export { default } from "%s";\nexport { state } from "/tmp/diff/stubs.mjs";\n' "$NEW"  > wnew.ts
node build.mjs wold.ts old.mjs && node build.mjs wnew.ts new.mjs && node run.mjs
```

Limits: the fake DB implements only the query shapes these routes use; the reminder
cron is not covered; the two handlers without try/catch are not exercised on DB failure
(an unhandled rejection hangs the request in Express 4, before and after).

# PRJ-03 differential test (ratings and templates)

Same idea for the other two extracted slices: 29 ratings requests and 37 templates requests
(including 409 name clashes with transaction rollback, role gates, and error paths) run against the
ORIGINAL code and the current code on one fake DB, comparing status, body, realtime events and
resulting rows. Current-time stamps are normalized.

- Ratings handlers live inside `routes/projects.ts`, so `prj03-mk.py` slices that handler block out
  of the original and the current file into two small routers (it reads `/tmp/orig/...` as the
  original upload and the repo path as current; edit the two paths at the top).
- Templates bundle the original and current `routes/project-templates.ts` directly.

```sh
mkdir /tmp/diff3 && cp scripts/antas/projects/differential/prj03-* /tmp/diff3 && cd /tmp/diff3
npm init -y && npm i express@4.21.2 esbuild@0.24.0 express-async-errors@3.1.1
python3 prj03-mk.py          # writes rold.ts rnew.ts told.ts tnew.ts
for f in rold rnew told tnew; do node prj03-build.mjs $f.ts $f.mjs; done
node prj03-run.mjs
```

Sensitivity was checked: changing one validation message or the average's rounding in the new
bundle made 8 and 2 ratings scenarios differ; changing one template error message made 5 differ.
Limits: the fake DB implements only the query shapes used here, and `express-async-errors` stands in
for the app's own async error handling.

# PRJ-03 differential test (core project CRUD)

45 requests against the ORIGINAL core-CRUD handlers (sliced verbatim from the original `routes/projects.ts`
together with `getOptionalUserId` and `formatProject`) and the current handlers, on one fake DB. Besides
status, body, realtime events, Telegram notifications and the delete cascade, it compares **the exact raw SQL
text** each version generates (the `sql.raw` fragments), which is the riskiest part of this move. Includes the
unescaped `deadline` injection text and a "raw row comes back snake_case" mode.

```sh
mkdir /tmp/diff4 && cp scripts/antas/projects/differential/prj03-crud-* /tmp/diff4 && cd /tmp/diff4
cp /tmp/diff3/package.json . && ln -s /tmp/diff3/node_modules node_modules   # or npm i express@4.21.2 esbuild@0.24.0 express-async-errors@3.1.1
python3 prj03-crud-mk.py && for f in cold cnew; do node prj03-crud-build.mjs $f.ts $f.mjs; done
cp prj03-crud-run.mjs run4.mjs && node run4.mjs
```

Sensitivity: changing one raw-SQL fragment's quoting made 2 scenarios differ; changing the page-size cap made 1.
Limit: the fake `execute` does not run SQL; it records it and returns canned rows, so SQL correctness against
real Postgres is not tested, only that the text is identical to the original.

# PRJ-04 differential test (ROI summary and P&L receipts)

35 requests against the ORIGINAL roi-summary and receipt handlers (sliced verbatim from the original
`routes/projects.ts`) and the current ones, on one fake DB. `crypto` is stubbed so tokens are deterministic, which
lets the harness force token collisions and exercise the 3-attempt retry and the 500 after three collisions. The
seed data includes float sums (0.1 + 0.2), a stored ROI of 0 whose fallback differs, a fractional investment,
earned-only and invested-only projects, an orphaned receipt and a receipt whose issuer no longer exists. The PDF
renderer is stubbed to capture the layout spec it is handed.

```sh
mkdir /tmp/diff5 && cp scripts/antas/projects/differential/prj04-* /tmp/diff5 && cd /tmp/diff5
cp /tmp/diff3/package.json . && ln -s /tmp/diff3/node_modules node_modules   # or npm i express@4.21.2 esbuild@0.24.0 express-async-errors@3.1.1
python3 prj04-mk.py && for f in old new; do node prj04-build.mjs $f.ts $f.mjs; done
cp prj04-run.mjs run5.mjs && node run5.mjs
```

Sensitivity (six mutations of the new bundle, patterns matched against the bundled text because esbuild removes
parentheses): roiPct formula, earned-only roiPct, `$` prefix, mint attempts 3 to 2, `??` to `||` on the stored ROI,
rounding invested. All detected after the seed data was strengthened; two were missed by the first seed data, which
could not tell `??` from `||` or see rounding on a whole-number amount.
Limits: the fake DB implements only these query shapes; the real PDF renderer and real Postgres `SUM` are not run.

# PRJ-05 differential test (whole file: all 34 routes of routes/projects.ts)

The strongest check in this set. The ORIGINAL 1302-line `routes/projects.ts` and the current thin adapter are each
bundled with every dependency stubbed (fake DB, PEP gates, credit meter, activity log, Vault KYC helpers, event hub,
Telegram, PDF renderer, deterministic `crypto`) and driven with the same 106 requests on the same seed data. It
compares status, body, **raw SQL text**, activity-log writes, credit charges, PEP gate resource checks, KYC audit
calls, realtime events, Telegram/sync side effects, PDF specs and the resulting rows. It covers every route group,
the PEP-gated paths (including silent denies), each enroll branch (create, reactivate, banned, conflict, KYC,
no credits), and earlier phases' routes (CRUD, ratings, ROI, receipts), so it also guards against regressions there.

```sh
mkdir /tmp/diff6 && cp scripts/antas/projects/differential/prj05-* /tmp/diff6 && cd /tmp/diff6
cp /tmp/diff3/package.json . && ln -s /tmp/diff3/node_modules node_modules   # or npm i express@4.21.2 esbuild@0.24.0 express-async-errors@3.1.1
cp prj05-stubs.mjs stubs6.mjs && cp prj05-build.mjs build6.mjs && cp prj05-run.mjs run6.mjs
O=<original upload>/artifacts/api-server/src/routes/projects.ts; N=<repo>/artifacts/api-server/src/routes/projects.ts
printf 'export { default } from "%s";\nexport { state } from "/tmp/diff6/stubs6.mjs";\n' $O > wold.ts
printf 'export { default } from "%s";\nexport { state } from "/tmp/diff6/stubs6.mjs";\n' $N > wnew.ts
node build6.mjs wold.ts old.mjs && node build6.mjs wnew.ts new.mjs && node run6.mjs
```

`GET /projects/mine/enrolled-entities` is unreachable as registered (shadowed), so this harness cannot exercise its
logic. `prj05-mk-unshadowed.py` + `prj05-run-unshadowed.mjs` mount the original and new handler on their own for 3
scenarios (copy the stubs/build files in as above first).

Sensitivity (mutations of the new bundle, each detected, patterns checked against the bundled text): a 409 message,
the enrollment and vault-entry owner sentinels, removing the KYC audit call, the reactivation log meta, a leaderboard
SQL fragment, skipping the "left" log, removing the reactivation credit charge. Two probes did not apply and were
discarded, not counted.
Limits: fake DB and stubbed PEP/credits/activity-log (their real behavior is not exercised, only that Projects calls
them identically); `execute` returns canned rows; the real PDF renderer and Postgres are not run.

## Update in PRJ-06 (intended differences)

The whole-file harness now tracks intended differences. Against the ORIGINAL file it must show exactly five:
`GET /projects/mine/enrolled-entities` (was 400, now 200: the route order fix), the two prototype-key status
scenarios (was 200 and set the status, now 400: PRJ-ISSUE-3), and the two quote scenarios for `deadline` and
`startedAt` (SQL text differs: PRJ-ISSUE-1, e.g. `started_at = '2026-04-04' OR '1'='1'` became
`started_at = '2026-04-04'' OR ''1''=''1'`). Any other difference, or an intended one that does not appear, fails
the run. Result at PRJ-06: 108 scenarios, 103 identical, 5 intended, 0 unexpected.

# PRJ-07 differential test (team and bulk enrollment billing)

Slices the ORIGINAL `POST /teams/:id/enroll-project` and `POST /projects/bulk-enroll` handlers and the current ones
into small routers on one fake DB with a quantity-aware fake credit meter (cost 2 per unit, balance in state). It
does NOT expect identical output: the new handlers may differ only in credit effects. For each scenario it strips
`_credits` from the new body and requires status, body, rows, inserts, notifications, events and activity log to
equal the original; then it asserts the exact charge quantity and balance debit (2 x units created), that a balance
one unit short returns 402 BEFORE any write, that nothing is charged when nothing was created (all enrolled, all
conflicting, join-only), and that the original never charged. 25 scenarios: 10 charged, 4 blocked, the rest
validation paths. Sensitivity: five mutations all detected (charge off by one, a one-unit pre-check in team and in
bulk, charging conflicting rows, never charging).

```sh
mkdir /tmp/diff7 && cp scripts/antas/projects/differential/prj07-* /tmp/diff7 && cd /tmp/diff7
cp /tmp/diff3/package.json . && ln -s /tmp/diff3/node_modules node_modules   # or npm i express@4.21.2 esbuild@0.24.0 express-async-errors@3.1.1
cp prj07-stubs.mjs stubs7.mjs && cp prj07-build.mjs build7.mjs && cp prj07-mk.py mk7.py && cp prj07-run.mjs run7.mjs
python3 mk7.py && for f in told tnew bold bnew; do node build7.mjs $f.ts $f.mjs; done && node run7.mjs
```
Limits: fake DB and fake credit meter; the real ledger transaction, price overrides (credit_action_pricing) and
concurrent spends are not exercised.
