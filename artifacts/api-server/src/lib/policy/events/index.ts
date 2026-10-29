/**
 * lib/policy/events/index.ts — Enforcement Roadmap, Track H, Phase H3.
 * DB-free barrel (see ./decision-event-observer.ts's header). The DB-backed
 * publisher adapter is `lib/policy-decision-events.ts`, deliberately NOT
 * re-exported from here — same split as `../audit/index.ts` and
 * `drizzle-audit-writer.ts`.
 */
export * from "./decision-event-observer";
