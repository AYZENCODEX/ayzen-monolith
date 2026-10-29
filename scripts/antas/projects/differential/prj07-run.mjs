process.env.NODE_ENV = "production";
import "express-async-errors";
import express from "express";
const J = { "content-type": "application/json" }, U = { "x-user": "7", ...J };
const seed = (st, o = {}) => {
  st.rows = { projects: [], user_projects: [], tasks: [], users: [], project_enrollments: [], vault_entries: [], project_ratings: [], entity_project_roi: [], project_pnl_receipts: [], finance_ledger_entries: [] };
  st.nextId = 3000; st.failTable = null; st.rawMode = "camel"; st.noCharge = false;
  for (const k of ["sqlLog", "activity", "charges", "pep", "audits", "events", "telegram", "synced", "pdf", "checks", "notes", "activityLog", "inserts"]) st[k].length = 0;
  st.balance = o.balance ?? 100; st.cost = 2; st.members = o.members ?? [7, 8, 9]; st.leaderRole = o.role ?? "leader"; st.owned = [10, 11, 12]; st.existingPairs = o.existingPairs ?? [];
  st.rows.projects.push({ id: 1, name: "Alpha" });
  st.rows.vault_entries.push({ id: 10, userId: 7 }, { id: 11, userId: 7 }, { id: 12, userId: 7 }, { id: 20, userId: 8 });
  for (const [u, p, v] of o.enrolled ?? []) st.rows.project_enrollments.push({ id: st.nextId++, userId: u, projectId: p, vaultEntryId: v, status: "active" });
  for (const u of o.joined ?? []) st.rows.user_projects.push({ userId: u, projectId: 1 });
};
const C = []; const add = (name, url, body, opt = {}, headers = U) => C.push({ name, url, body, opt, headers });
// teams: POST /teams/5/enroll-project
add("team: 3 members need enrollment", "/teams/5/enroll-project", { projectId: 1, vaultEntryId: 10 }, { expectCharge: 3 });
add("team: 1 of 3 already enrolled", "/teams/5/enroll-project", { projectId: 1, vaultEntryId: 10 }, { enrolled: [[8, 1, 10]], expectCharge: 2 });
add("team: all already enrolled", "/teams/5/enroll-project", { projectId: 1, vaultEntryId: 10 }, { enrolled: [[7, 1, 10], [8, 1, 10], [9, 1, 10]], expectCharge: 0 });
add("team: no vaultEntryId (join only)", "/teams/5/enroll-project", { projectId: 1 }, { expectCharge: 0 });
add("team: single-member team", "/teams/5/enroll-project", { projectId: 1, vaultEntryId: 10 }, { members: [7], expectCharge: 1 });
add("team: balance exactly enough (6)", "/teams/5/enroll-project", { projectId: 1, vaultEntryId: 10 }, { balance: 6, expectCharge: 3 });
add("team: balance one short (5) -> 402", "/teams/5/enroll-project", { projectId: 1, vaultEntryId: 10 }, { balance: 5, expect402: true });
add("team: balance 0 -> 402", "/teams/5/enroll-project", { projectId: 1, vaultEntryId: 10 }, { balance: 0, expect402: true });
add("team: balance 0 but nothing to enroll -> ok", "/teams/5/enroll-project", { projectId: 1, vaultEntryId: 10 }, { balance: 0, enrolled: [[7, 1, 10], [8, 1, 10], [9, 1, 10]], expectCharge: 0 });
add("team: not leader -> 403", "/teams/5/enroll-project", { projectId: 1, vaultEntryId: 10 }, { role: "member", expectCharge: 0 });
add("team: missing projectId -> 400", "/teams/5/enroll-project", { vaultEntryId: 10 }, { expectCharge: 0 });
add("team: unknown project -> 404", "/teams/5/enroll-project", { projectId: 99, vaultEntryId: 10 }, { expectCharge: 0 });
add("team: entity not owned -> 404", "/teams/5/enroll-project", { projectId: 1, vaultEntryId: 20 }, { expectCharge: 0 });
// bulk: POST /projects/bulk-enroll
add("bulk: 3 owned ids", "/projects/bulk-enroll", { projectId: 1, entityIds: [10, 11, 12] }, { expectCharge: 3 });
add("bulk: ids + serials merged (dedupe to 3)", "/projects/bulk-enroll", { projectId: 1, entityIds: [10, 11], entitySerials: ["S-12"] }, { expectCharge: 3 });
add("bulk: non-owned id dropped", "/projects/bulk-enroll", { projectId: 1, entityIds: [10, 20, 99] }, { expectCharge: 1 });
add("bulk: duplicate ids in request", "/projects/bulk-enroll", { projectId: 1, entityIds: [10, 10, 10] }, { expectCharge: 1 });
add("bulk: rowCount 0 rows (conflict) are not charged", "/projects/bulk-enroll", { projectId: 1, entityIds: [10, 11, 12] }, { existingPairs: [[1, 10], [1, 12]], expectCharge: 1 });
add("bulk: all conflict -> no charge", "/projects/bulk-enroll", { projectId: 1, entityIds: [10, 11] }, { existingPairs: [[1, 10], [1, 11]], expectCharge: 0 });
add("bulk: balance exactly enough (6)", "/projects/bulk-enroll", { projectId: 1, entityIds: [10, 11, 12] }, { balance: 6, expectCharge: 3 });
add("bulk: balance one short (5) -> 402", "/projects/bulk-enroll", { projectId: 1, entityIds: [10, 11, 12] }, { balance: 5, expect402: true });
add("bulk: 402 even when some would conflict (pre-check is the upper bound)", "/projects/bulk-enroll", { projectId: 1, entityIds: [10, 11, 12] }, { balance: 4, existingPairs: [[1, 10]], expect402: true });
add("bulk: no entities -> 400 (before billing)", "/projects/bulk-enroll", { projectId: 1, entityIds: [99] }, { balance: 0, expectCharge: 0 });
add("bulk: missing projectId -> 400", "/projects/bulk-enroll", { entityIds: [10] }, { expectCharge: 0 });
add("bulk: unauth -> 401", "/projects/bulk-enroll", { projectId: 1, entityIds: [10] }, { expectCharge: 0 }, J);
const today = new Date().toISOString().slice(0, 10);
async function run(file) {
  const mod = await import(file); const app = express(); app.use(express.json()); app.use(mod.default);
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); }); const port = srv.address().port; const out = []; const st = mod.state;
  for (const c of C) { seed(st, c.opt); const res = await fetch(`http://127.0.0.1:${port}${c.url}`, { method: "POST", headers: c.headers, body: JSON.stringify(c.body) });
    const text = await res.text(); out.push({ name: c.name, status: res.status, text, charges: JSON.parse(JSON.stringify(st.charges)), checks: JSON.parse(JSON.stringify(st.checks)), balance: st.balance, enrollRows: st.rows.project_enrollments.length, userProjects: st.rows.user_projects.length, inserts: st.inserts.length, notes: st.notes.length, events: JSON.stringify(st.events), activityLog: JSON.stringify(st.activityLog) }); }
  srv.close(); return out;
}

const split = (arr) => arr;
// each case runs against whichever pair of bundles matches its URL
const pair = { teams: ["told.mjs", "tnew.mjs"], bulk: ["bold.mjs", "bnew.mjs"] };
async function runPair(kind) {
  const cases = C.filter((c) => (kind === "teams" ? c.url.startsWith("/teams") : c.url.startsWith("/projects")));
  const prev = [...C]; C.length = 0; C.push(...cases);
  const a = await run(`${process.cwd()}/${pair[kind][0]}`), b = await run(`${process.cwd()}/${pair[kind][1]}`);
  C.length = 0; C.push(...prev); return { cases, a, b };
}
let bad = 0, total = 0, charged = 0, blocked = 0;
for (const kind of ["teams", "bulk"]) {
  const { cases, a, b } = await runPair(kind);
  a.forEach((x, i) => { const y = b[i]; const o = cases[i].opt; total++;
    const strip = (r) => { const body = r.text.replace(/,"_credits":(null|\{[^}]*\})/, ""); return JSON.stringify({ status: r.status, body, enrollRows: r.enrollRows, userProjects: r.userProjects, inserts: r.inserts, notes: r.notes, events: r.events, activityLog: r.activityLog }); };
    const qty = (y.charges[0] ?? [0, 0, 0])[2];
    const problems = [];
    if (o.expect402) { if (!(x.status === 201 || x.status === 200)) problems.push("old did not succeed"); if (y.status !== 402) problems.push("new not 402: " + y.status); if (y.enrollRows !== 0 || y.inserts !== 0) problems.push("new wrote rows before the 402"); if (y.charges.length) problems.push("charged on a 402"); blocked++; }
    else { if (strip(x) !== strip(y)) problems.push("behavior differs beyond billing: " + strip(x).slice(0, 160) + " | " + strip(y).slice(0, 160)); if (x.charges.length) problems.push("old charged?!"); if (o.expectCharge > 0) { if (qty !== o.expectCharge) problems.push(`charged qty ${qty}, expected ${o.expectCharge}`); if (y.balance !== 100 - 0 && o.balance === undefined && y.balance !== 100 - 2 * o.expectCharge) problems.push("balance not debited correctly: " + y.balance); charged++; } else if (y.charges.length) problems.push("charged when nothing was created: " + JSON.stringify(y.charges)); }
    if (problems.length) { bad++; console.log("PROBLEM", cases[i].name, problems.join("; ")); }
  });
}
console.log(`billing: ${total} scenarios, ${total - bad} as expected, ${bad} problems; ${charged} charged correctly, ${blocked} blocked with 402 before any write`);
process.exit(bad ? 1 : 0);
