# Extraction candidate list

Phase 0 deliverable. Ranked using the roadmap's own criteria ("Extract when
at least several of: independent scaling requirement, independent deployment
requirement, strong security boundary, heavy workload, different failure
profile, different data lifecycle, clear domain ownership, separate
operational team/ownership, external integration complexity, expensive
compute") cross-referenced against what the repository scan actually found
(route/lib/migration/cron counts, declared vs. enforced table ownership,
confirmed cross-domain imports).

## Tier 1 — extract first (clear ownership, contained blast radius, unblocks others)

1. **Identity** — root of trust for every other domain; no confirmed
   cross-domain imports *into* it from business domains (only outbound: other
   domains depend on it). Largest route surface by file count (30+
   `oidc-*.ts` files) but that surface is cohesive, not tangled with other
   domains. High operational importance means high care, not high difficulty.
2. **Event Bus** — already the most isolated subsystem (`lib/event-bus/*`
   plus `packages/events`/`packages/event-client`), infrastructure rather
   than business logic, and every other extraction depends on it being solid
   first (Phase 6 in the roadmap, ahead of every domain extraction).
3. **Workspace** — smallest confirmed cross-domain import surface, and
   already the one domain (besides Telegram Gateway) that calls
   `assertTableOwnedBy` at runtime. Tenancy root, so it should ship early
   alongside Identity.

## Tier 2 — extract once Tier 1 lands (clean data ownership, moderate coupling)

4. **Notification** — clean fan-in role in the target architecture, but must
   be re-wired from direct synchronous calls (`notification-bus.ts` →
   `routes/notifications.ts`, `lib/telegram.ts`, `lib/email.ts`) onto the
   event bus before extraction, or the extracted service will still need
   synchronous access to Telegram Gateway and Mail internals.
5. **Telegram Gateway** — webhook verification and update idempotency are
   already isolated; largest remaining coupling is the direct calls *into* it
   from Vault and Finance (see `boundary-findings.md`), which need to become
   either public API calls or events first.
6. **Search / Knowledge**, **Analytics** — smallest data footprint, no
   declared event surface, low operational importance. Low risk either way;
   can be extracted late or kept in the monolith indefinitely per the
   roadmap's "what should stay" guidance.

## Tier 3 — extract carefully, highest coupling and schema churn

7. **Vault / SYLO** — largest route surface in the repository
   (`routes/vault.ts` alone is 108K, 11 vault-prefixed route files total),
   20 of 104 migrations, 5 of 17 cron jobs, and three confirmed direct
   cross-domain imports out to Notification, Telegram Gateway and
   Marketplace. Highest operational importance (user data custody) combined
   with highest coupling — do not extract until `boundary-findings.md` items
   1–3 for Vault are closed.
8. **Finance / RYFT** — 16 of 104 migrations (single largest migration
   family), 9 route files, 6 of 17 cron jobs, confirmed direct imports into
   Mail and Telegram Gateway from `finance-invoices.ts`. Revenue-bearing, so
   correctness risk during cutover is high.
9. **Mail / WISP** — 20 of 104 migrations (tied with Vault), external
   SMTP/IMAP provider integration adds failure modes beyond this codebase's
   control; shares the ambiguous `notification.requested/delivered/failed`
   event names with Notification (needs resolving in Phase 2 first).
10. **Workflow / SKARN** — currently the busiest event producer in the whole
    system (18 of 19 non-infrastructure `publishEvent` call sites). Extracting
    it changes the shape of the event bus's dominant traffic pattern, so it
    should follow Event Bus hardening (Tier 1, #2) directly and be measured
    under real load before cutover.

## Not yet ranked — insufficient boundary work done

- **Authorization** — called from nearly every route file as middleware
  (PEP/PDP in `lib/policy/*`); extracting it means every other service needs
  a remote policy-check round trip. Needs a latency/availability plan before
  it can be ranked against the others.
- **AI / ZYNTH**, **Marketplace** — moderate-to-large route surfaces (AI
  overlaps three internal engines; Marketplace has 13 route files) but no
  confirmed direct cross-domain imports were found in this scan. Re-scan
  after Tier 1/2 land, since some of their coupling may be indirect (through
  `services/sync.ts` or the engines) and wasn't captured by the import-level
  grep used here.

## What this list is not

This is a Phase 0 map, not a Phase-24 (Strangler Migration) schedule. Per the
roadmap's own rule, "never simultaneous extraction of many dependent
domains" — Tier 1 must be fully extracted (owned schema, real handlers, auth,
events, tests, rollback — not just a routed process) before Tier 2 begins,
and Tier 3 should not start until the specific cross-domain imports listed in
`boundary-findings.md` are closed for each Tier 3 domain.
