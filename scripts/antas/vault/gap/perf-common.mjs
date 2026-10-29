// VLT-GAP-20 shared engine (Hardening H3: performance / query regression). Used by 20-A (capture) and 20-B (judge).
// Runs the FROZEN pre-extraction route files and the CURRENT route files (+ every vault/ module they pull in) under the SAME
// deterministic fakes as GAP-15 (equivalence-replay), and measures, per route x scenario:
//   statements   DB round trips (db.select/insert/update/delete/execute, pool.query, client.query)
//   shapes       statements per "<op> <table>" so a new kind of query is visible, not only a bigger count
//   calls        non-DB boundary calls (encrypt, audit, events, charge, ...)
//   handler ms   wall time of the business handler (in-memory fakes => measures CPU/await overhead of the code path, not Postgres)
// N+1 is detected structurally: statements(2 rows) - statements(1 row) > 0 means the code issues queries per row.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./gap-common.mjs";
import { createLoader } from "./harness.mjs";
import { ts, SRC, SCENARIOS, makeEnv, freezeWorld } from "./equivalence-replay.mjs";
import { cfg, groupInputs } from "./equivalence-suite.mjs";

export const GAPDIR = path.join(ROOT, "scripts/antas/vault/gap");
export const pcfg = JSON.parse(fs.readFileSync(path.join(GAPDIR, "gap-configs/vault-perf.json"), "utf8"));
export const SCN = Object.fromEntries(SCENARIOS.map((s) => [s.id, s]));
// perf-only scenario: same as row-db but every row carries data_entity_id, so branches gated on `row.data_entity_id` (KYC create/update re-read, entity
// representation, snapshot restore) are executed. Defined here, not in equivalence-replay, so GAP-15 evidence is untouched.
SCN["row-db-linked"] = { ...SCN["row-db"], id: "row-db-linked", extraRow: { data_entity_id: 3, dataEntityId: 3 } };
// perf-only scenario: a valid 2-entry AYZEN JSON import body, so POST /vault/import reaches its row loop (the generic body is rejected with 400 before any DB call)
SCN["row-db-import"] = { ...SCN["row-db"], id: "row-db-import", body: { format: "ayzen_json", data: JSON.stringify([{ projectName: "A", username: "u1" }, { projectName: "B", username: "u2", password: "pw" }]) } };
export const routeGroupNames = () => Object.keys(cfg.groups).filter((g) => g !== "health");
export const currentOnlyGroups = () => pcfg.current_only_groups ?? {};
export const perfGroupNames = () => [...routeGroupNames(), ...Object.keys(currentOnlyGroups())];
export const scenariosFor = (g) => pcfg.scenarios.filter((sid) => !pcfg.scenario_groups?.[sid] || pcfg.scenario_groups[sid].includes(g));
const STMT = /^(db\.(select|selectDistinct|insert|update|delete|execute)|pool\.query|client\.query)$/;
// Non-DB boundary calls. The generic fakes log `call:<name>` / `autostub:<module>.<name>`, but a few collaborators are recorded under their BARE name
// (harness.mjs): money (chargeCredits), authorization decisions, activity/sync/marketplace side effects. They must count too, or a double charge or an
// extra authorize/audit call would be invisible to V4 (found by 20-D plant Q3).
const BOUNDARY_BARE = /^(chargeCredits|authorize|authorizeMany|logSubjectActivity|syncOnVaultDelete|delistVaultMarketplaceListings)$/;
const NOW = () => performance.now();

// ── minimal request/response doubles (same shape as equivalence-replay's, no recording needed here) ──
function mkRes() {
  const r = { statusCode: undefined };
  const px = new Proxy(r, {
    get: (t, p) => {
      if (p === "then") return undefined;
      if (typeof p === "symbol" || p in t) return t[p];
      return (...a) => { if (p === "status" || p === "sendStatus") t.statusCode = a[0]; else if (p === "json") t.body = a[0]; return px; };
    },
    set: (t, p, v) => { t[p] = v; return true; },
  });
  return px;
}
function mkReq(route, scn) {
  const params = {}; for (const m of route.path.matchAll(/:([A-Za-z0-9_]+)/g)) params[m[1]] = /Type$/.test(m[1]) ? "entity" : "1";
  const user = scn.user === undefined ? { userId: 10, id: 10, role: "user", username: "alice", email: "alice@example.test" } : scn.user ? { id: scn.user.userId, username: "alice", email: "alice@example.test", ...scn.user } : undefined;
  return { method: route.method, path: route.path, originalUrl: route.path, params, query: {}, body: scn.body, headers: { "user-agent": "replay" }, user, ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" }, get: () => undefined, header: () => undefined, on: () => {}, correlationId: "corr-1", log: { info() {}, warn() {}, error() {} } };
}

// ── log -> metrics ─────────────────────────────────────────────────────────
const tableOf = (a) => { const s = JSON.stringify(a ?? ""); const m = /table\(([^)]+)\)/.exec(s); return m ? m[1] : "?"; };
export function metricsOf(log) {
  const shapes = {}; let statements = 0, calls = 0, tx = 0;
  for (let i = 0; i < log.length; i++) {
    const [label, args] = log[i]; const l = String(label);
    if (STMT.test(l)) {
      statements++;
      let key = l;
      if (l === "db.select") { const f = log.slice(i + 1, i + 4).find((e) => e[0] === "db.select.from"); key = `select ${f ? tableOf(f[1]) : "?"}`; }
      else if (/^db\.(insert|update|delete)$/.test(l)) key = `${l.slice(3)} ${tableOf(args)}`;
      else if (l === "db.execute") key = "execute";
      else key = l.replace(".query", "");
      shapes[key] = (shapes[key] ?? 0) + 1;
    } else if (/^client\.(query|release)$/.test(l) && l === "client.release") tx++;
    else if (/^(autostub:.*\.|call:)/.test(l) || BOUNDARY_BARE.test(l)) calls++;
  }
  return { statements, shapes: Object.fromEntries(Object.entries(shapes).sort()), calls, tx };
}

// ── load a file set once, return the route table + env ───────────────────────
function loadSet({ files, texts, scn, bind = {} }) {
  const env = makeEnv(scn);
  if (scn.extraRow) { const base = env.dflt; const add = (r) => (r && typeof r === "object" && !Array.isArray(r) ? { ...r, ...scn.extraRow } : r); env.dflt = (key, ...rest) => { const v = base(key, ...rest); return Array.isArray(v) ? v.map(add) : v && Array.isArray(v.rows) ? { ...v, rows: v.rows.map(add) } : v; }; }
  const loader = createLoader({ ts, root: ROOT, srcDir: SRC, env });
  const loadErrors = []; const bound = new Set(Object.values(bind));
  for (const f of [...files.filter((x) => bound.has(x)), ...files.filter((x) => !bound.has(x))]) {
    try {
      const exp = texts?.[f] ? loader.loadText(texts[f], f, path.join(SRC, "routes")) : loader.loadFile(path.join(SRC, f));
      for (const [k, tgt] of Object.entries(bind)) if (f === tgt) env.stubs[k] = exp;
    } catch (e) { loadErrors.push(`${f}: ${String(e.message ?? e).slice(0, 160)}`); }
  }
  const routes = new Map();
  for (const r of env.routes.slice().sort((a, b) => (`${a.method} ${a.path}` < `${b.method} ${b.path}` ? -1 : 1))) { const k = `${r.method} ${r.path}`; if (!routes.has(k)) routes.set(k, r); }
  return { env, routes, loadErrors };
}
async function runOnce(set, r, scn) {
  const { env } = set; env.log.length = 0; env.syncDeleteRejects = false;
  const res = mkRes(), req = mkReq(r, scn), handler = r.stack[r.stack.length - 1];
  let timer, threw = null; const t0 = NOW();
  try { await Promise.race([Promise.resolve(handler(req, res, () => {})), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("PERF_TIMEOUT")), 400); })]); await new Promise((x) => setImmediate(x)); }
  catch (e) { threw = String(e?.message ?? e).slice(0, 80); } finally { clearTimeout(timer); }
  const ms = NOW() - t0;
  return { ms, threw, status: res.statusCode ?? null, metrics: metricsOf(env.log.map((e) => (Array.isArray(e) ? e : [e]))) };
}

export const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
export const r3 = (x) => Math.round(x * 1000) / 1000;

// Profile one group: for every route x scenario run OLD and NEW; `reps` timed repetitions interleaved old/new.
export async function profileGroup(g, reps) {
  freezeWorld();
  const co = currentOnlyGroups()[g];
  const inp = co ? { oldFiles: co.files, texts: {}, bind: {}, newFiles: co.files } : groupInputs(g, cfg.groups[g]); // current-only: OLD side == current files (no frozen original exists)
  const out = { group: g, current_only: !!co, loadErrors: [], cells: {}, old_routes: [], new_routes: [] };
  for (const sid of scenariosFor(g)) {
    const scn = SCN[sid];
    const O = loadSet({ files: inp.oldFiles, texts: inp.texts, scn, bind: inp.bind });
    const N = loadSet({ files: inp.newFiles, scn });
    out.loadErrors.push(...O.loadErrors.map((e) => `old ${e}`), ...N.loadErrors.map((e) => `new ${e}`));
    for (const k of O.routes.keys()) if (!out.old_routes.includes(k)) out.old_routes.push(k);
    for (const k of N.routes.keys()) if (!out.new_routes.includes(k)) out.new_routes.push(k);
    for (const [k, ro] of O.routes) {
      const rn = N.routes.get(k); const cell = { old: null, new: null, deterministic: false };
      const oT = [], nT = []; let o1, n1, n2;
      for (let i = 0; i < reps; i++) {
        const a = await runOnce(O, ro, scn); const b = rn ? await runOnce(N, rn, scn) : null;
        if (i === 0) { o1 = a; n1 = b; } if (i === 1) n2 = b;
        oT.push(a.ms); if (b) nT.push(b.ms);
      }
      cell.old = { ...o1.metrics, status: o1.status, threw: o1.threw, ms: r3(pct(oT, 50)) };
      if (n1) { cell.new = { ...n1.metrics, status: n1.status, threw: n1.threw, ms: r3(pct(nT, 50)) }; cell.deterministic = !n2 || JSON.stringify(n1.metrics) === JSON.stringify(n2.metrics); }
      out.cells[`${k} @ ${sid}`] = cell;
    }
  }
  return out;
}

// ── analysis (pure functions, used by A to summarise and by B to judge — and by B's mutation self-test) ──────────────
export function nPlusOne(cells) {
  // per route: statements(two rows) > statements(one row) on the same side => per-row queries
  const res = { old: [], new: [] };
  for (const side of ["old", "new"]) {
    for (const key of Object.keys(cells)) {
      const [route, sid] = key.split(" @ "); if (sid !== pcfg.n_plus_one.one_row) continue;
      const many = cells[`${route} @ ${pcfg.n_plus_one.many_rows}`]; const one = cells[key];
      if (!many?.[side] || !one?.[side]) continue;
      const d = many[side].statements - one[side].statements;
      if (d > 0) res[side].push({ route, extra_statements_for_second_row: d, one_row: one[side].statements, two_rows: many[side].statements });
    }
  }
  return res;
}
export function latency(cells, side) {
  const live = Object.values(cells).filter((c) => c[side] && c[side].threw !== "PERF_TIMEOUT"); // a handler that never answers within the harness timeout is reported, not timed
  const ms = live.map((c) => c[side].ms);
  return { samples: ms.length, timed_out: Object.values(cells).filter((c) => c[side]?.threw === "PERF_TIMEOUT").length, p50: r3(pct(ms, 50)), p95: r3(pct(ms, 95)), p99: r3(pct(ms, 99)), total: r3(ms.reduce((a, b) => a + b, 0)) };
}
export const statementsTotal = (cells, side) => Object.values(cells).reduce((n, c) => n + (c[side]?.statements ?? 0), 0);

// ── judge: pure function over (current profiles, baseline capture, config). Returns { violations, improvements, ... } ────────
// cur:  { [group]: { cells, old_routes, new_routes } }          (fresh run)
// base: { [group]: { cells } }  counts captured by 20-A         (only counts are compared; ms is re-measured)
export function judge(cur, base, cf = pcfg, { timing = true } = {}) {
  const V = [], improvements = [], seenAllowed = new Set();
  const add = (code, msg) => V.push({ code, msg });
  const allowed = (cell, metric, o, n) => { const i = (cf.intentional_changes ?? []).findIndex((x) => x.cell === cell && x.metric === metric && x.old === o && x.new === n); if (i >= 0) seenAllowed.add(i); return i >= 0; };
  const nplus = { old: [], new: [], introduced: [], worsened: [] };
  const lat = {};
  for (const [g, r] of Object.entries(cur)) {
    // V1 coverage: every route the OLD code served must still be served, in every scenario
    for (const k of r.old_routes) if (!r.new_routes.includes(k)) add("V1_ROUTE_MISSING", `${g}: ${k} served by OLD code, absent now`);
    for (const [key, c] of Object.entries(r.cells)) {
      const id = `${g}::${key}`;
      if (!c.new) { add("V1_ROUTE_MISSING", `${id}: no current-side profile`); continue; }
      if (!c.deterministic) add("V9_NON_DETERMINISTIC", `${id}: query profile differs between two identical runs`);
      // V2 statements (DB round trips)
      if (c.new.statements > c.old.statements) { if (!allowed(id, "statements", c.old.statements, c.new.statements)) add("V2_MORE_QUERIES", `${id}: ${c.old.statements} -> ${c.new.statements} DB statements`); }
      else if (c.new.statements < c.old.statements) { if (!allowed(id, "statements", c.old.statements, c.new.statements)) improvements.push(`${id}: ${c.old.statements} -> ${c.new.statements} DB statements`); }
      // V3 per-shape: no new kind of query, no shape that grew
      for (const [s, n] of Object.entries(c.new.shapes)) { const o = c.old.shapes[s] ?? 0; if (n > o && !allowed(id, `shape:${s}`, o, n)) add("V3_NEW_QUERY_SHAPE", `${id}: '${s}' ${o} -> ${n}`); }
      // V4 boundary calls (encrypt/audit/event/charge...) must not multiply
      if (c.new.calls > c.old.calls && !allowed(id, "calls", c.old.calls, c.new.calls)) add("V4_MORE_BOUNDARY_CALLS", `${id}: ${c.old.calls} -> ${c.new.calls} boundary calls`);
      // V6 drift against the 20-A capture (counts only)
      const b = base?.[g]?.cells?.[key];
      if (!b) add("V6_BASELINE_DRIFT", `${id}: not in the 20-A capture (re-run 20-A)`);
      else {
        for (const side of ["old", "new"]) for (const m of ["statements", "calls", "tx"]) if (b[side]?.[m] !== c[side]?.[m]) add("V6_BASELINE_DRIFT", `${id}: ${side}.${m} captured ${b[side]?.[m]} now ${c[side]?.[m]} (re-run 20-A after review)`);
        if (JSON.stringify(b.new?.shapes) !== JSON.stringify(c.new.shapes)) add("V6_BASELINE_DRIFT", `${id}: new.shapes changed since capture`);
      }
    }
    // V6b every captured cell must still be profiled (a route removed from BOTH sides, e.g. a current-only group, would otherwise vanish silently)
    for (const key of Object.keys(base?.[g]?.cells ?? {})) if (!(key in r.cells)) add("V6_BASELINE_DRIFT", `${g}::${key}: captured cell is no longer profiled (route or scenario removed)`);
    // V5 N+1
    const np = nPlusOne(r.cells);
    for (const o of np.old) nplus.old.push({ group: g, ...o });
    for (const n of np.new) {
      nplus.new.push({ group: g, ...n });
      const o = np.old.find((x) => x.route === n.route);
      if (!o) { nplus.introduced.push(`${g}: ${n.route}`); add("V5_N_PLUS_ONE_INTRODUCED", `${g}: ${n.route} issues ${n.extra_statements_for_second_row} extra statement(s) per extra row; OLD code did not`); }
      else if (n.extra_statements_for_second_row > o.extra_statements_for_second_row) { nplus.worsened.push(`${g}: ${n.route}`); add("V5_N_PLUS_ONE_WORSE", `${g}: ${n.route} per-row statements ${o.extra_statements_for_second_row} -> ${n.extra_statements_for_second_row}`); }
    }
    // V7 latency (in-memory path cost; coarse by design)
    const lo = latency(r.cells, "old"), ln = latency(r.cells, "new"); lat[g] = { old: lo, new: ln };
    if (lo.timed_out !== ln.timed_out) add("V7_TIMEOUT_MISMATCH", `${g}: handlers not answering in harness: old ${lo.timed_out}, new ${ln.timed_out}`);
    if (timing) {
      const t = cf.timing;
      if (ln.p50 > lo.p50 * t.p50_factor + t.abs_slack_ms) add("V7_LATENCY_P50", `${g}: p50 ${lo.p50}ms -> ${ln.p50}ms`);
      if (ln.p95 > lo.p95 * t.p95_factor + t.abs_slack_ms) add("V7_LATENCY_P95", `${g}: p95 ${lo.p95}ms -> ${ln.p95}ms`);
      if (ln.p99 > lo.p99 * t.p99_factor + t.p99_abs_slack_ms) add("V7_LATENCY_P99", `${g}: p99 ${lo.p99}ms -> ${ln.p99}ms`);
      if (ln.total > lo.total * t.total_factor + t.total_abs_slack_ms) add("V7_LATENCY_TOTAL", `${g}: total ${lo.total}ms -> ${ln.total}ms`);
    }
  }
  // V8 an allowance that no longer matches reality must be removed
  (cf.intentional_changes ?? []).forEach((x, i) => { if (!seenAllowed.has(i)) add("V8_STALE_ALLOWANCE", `intentional change not observed any more: ${x.cell} ${x.metric} ${x.old}->${x.new}`); });
  return { violations: V, improvements, n_plus_one: nplus, latency: lat };
}
export const timingOnly = (v) => v.length > 0 && v.every((x) => x.code.startsWith("V7_LATENCY"));
