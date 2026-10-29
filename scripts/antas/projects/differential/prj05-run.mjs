process.env.NODE_ENV = "production";
import "express-async-errors";
import express from "express";
const D = (s) => new Date(s);
const J = { "content-type": "application/json" };
const U7 = { "x-user": "7" }, U8 = { "x-user": "8" }, U9 = { "x-user": "9" };
const ADM = { "x-user": "1", "x-admin": "1", "x-role": "admin", ...J }, MOD = { "x-user": "2", "x-role": "moderator", ...J };
const u7 = { ...U7, ...J }, u8 = { ...U8, ...J };
const seed = (st, opt = {}) => {
  st.rows = { projects: [], user_projects: [], tasks: [], users: [], project_enrollments: [], vault_entries: [], project_ratings: [], entity_project_roi: [], project_pnl_receipts: [], finance_ledger_entries: [] };
  st.nextId = 2000; st.failTable = opt.fail ?? null; st.rawMode = opt.raw ?? "camel"; st.noCharge = Boolean(opt.noCharge);
  for (const k of ["sqlLog", "activity", "charges", "pep", "audits", "events", "telegram", "synced", "pdf"]) st[k].length = 0; st.tokenCounter = 0;
  const c = D("2026-01-01T00:00:00Z"), r = st.rows;
  r.projects.push({ id: 1, name: "Alpha Protocol", tier: "1", createdAt: c, xpPrice: 0.01, totalRoiDistributed: 12.5, thumbnailUrl: "a.png" }, { id: 2, name: "beta quest", tier: "2", createdAt: c, xpPrice: 0.5, totalRoiDistributed: 0, thumbnailUrl: null }, { id: 3, name: "Gamma", tier: "1", createdAt: c, xpPrice: 1, totalRoiDistributed: 3, thumbnailUrl: null });
  r.users.push({ id: 7, username: "alice" }, { id: 8, username: "bob" });
  r.tasks.push({ id: 1, projectId: 1, title: "t1", createdAt: c }, { id: 2, projectId: 1, title: "t2", createdAt: c }, { id: 3, projectId: 2, title: "t3", createdAt: c });
  r.user_projects.push({ userId: 7, projectId: 1 }, { userId: 8, projectId: 1 }, { userId: 7, projectId: 2 });
  r.vault_entries.push({ id: 10, userId: 7, entitySerial: "E-10", projectName: "Ten", category: "c", twitterUsername: "t", discordUsername: "d", walletAddresses: '["0x1"]', email: "e@x" }, { id: 11, userId: 7, entitySerial: "E-11", projectName: "Eleven", category: null, twitterUsername: null, discordUsername: null, walletAddresses: null, email: null }, { id: 20, userId: 8, entitySerial: "E-20", projectName: "Twenty", category: "c", twitterUsername: null, discordUsername: null, walletAddresses: "[]", email: null });
  const e = (id, userId, projectId, vaultEntryId, status, extra = {}) => r.project_enrollments.push({ id, userId, projectId, vaultEntryId, status, enrolledAt: D("2026-01-02T00:00:00Z"), accountData: null, kycEntryId: null, dataEntityId: null, ...extra });
  e(1, 7, 1, 10, "active"); e(2, 7, 1, 11, "banned"); e(3, 7, 2, 10, "disqualified", { accountData: '{"a":1}', kycEntryId: 5, dataEntityId: 3 }); e(4, 8, 1, 20, "active", { kycEntryId: 6 }); e(5, 7, 3, 10, "cancelled");
  st.kyc = { 5: { id: 5, userId: 7 }, 6: { id: 6, userId: 8 } };
  r.project_ratings.push({ id: 1, projectId: 1, userId: 7, rating: 5, comment: "great", createdAt: c, updatedAt: D("2026-02-01T00:00:00Z") }, { id: 2, projectId: 1, userId: 8, rating: 2, comment: null, createdAt: c, updatedAt: D("2026-03-01T00:00:00Z") });
  r.entity_project_roi.push({ id: 1, userId: 7, projectId: 1, vaultEntryId: 10, totalProfit: 100.4, totalCost: 40, roi: null, recordedAt: D("2026-02-01T00:00:00Z") }, { id: 2, userId: 7, projectId: 1, vaultEntryId: 11, totalProfit: 9, totalCost: 1, roi: 0, recordedAt: D("2026-02-02T00:00:00Z") });
  r.finance_ledger_entries.push({ id: 1, userId: 7, projectId: 1, kind: "investment", amount: 100.4 }, { id: 2, userId: 7, projectId: 1, kind: "expense", amount: 40.1 }, { id: 3, userId: 7, projectId: 1, kind: "income", amount: 70.2 }, { id: 4, userId: 7, projectId: 2, kind: "income", amount: 5 });
  r.project_pnl_receipts.push({ id: 1, userId: 7, projectId: 1, receiptToken: "tok-p1", createdAt: c }, { id: 2, userId: 7, projectId: 77, receiptToken: "tok-orphan", createdAt: c });
};
const today = new Date().toISOString().slice(0, 10);
const nz = (t) => t.replace(/"generatedAt":"[^"]+"/g, '"generatedAt":"NOW"').replace(new RegExp(`"${today}T[\\d:.]+Z"`, "g"), '"NOW"');
const C = []; const add = (name, method, url, headers, body, opt) => C.push({ name, method, url, headers, body, opt });
// entity overview + gates
add("entity overview own", "GET", "/projects/entity/10/overview", U7); add("entity overview empty entity", "GET", "/projects/entity/11/overview", U7); add("entity overview NOT owned (silent deny)", "GET", "/projects/entity/20/overview", U7);
add("entity overview NaN (silent deny)", "GET", "/projects/entity/abc/overview", U7); add("entity overview unauth", "GET", "/projects/entity/10/overview", {}); add("entity overview db failure", "GET", "/projects/entity/10/overview", U7, null, { fail: "projects" });
// enrolled family
add("enrolled", "GET", "/projects/enrolled", U7); add("enrolled db failure", "GET", "/projects/enrolled", U7, null, { fail: "projects" }); add("enrolled-entities p1", "GET", "/projects/1/enrolled-entities", U7); add("enrolled-entities NaN", "GET", "/projects/abc/enrolled-entities", U7);
add("mine/enrolled-entities (was shadowed, PRJ-06)", "GET", "/projects/mine/enrolled-entities", U7); add("entity-leaderboard", "GET", "/projects/entity-leaderboard", U7); add("entity-leaderboard db failure", "GET", "/projects/entity-leaderboard", U7, null, { fail: "projects" });
// CRUD
add("list", "GET", "/projects", {}); add("list filters", "GET", "/projects?tier=1&search=alpha&type=defi&accountCategory=both", {}); add("list page", "GET", "/projects?page=2&limit=1", {});
add("detail anon", "GET", "/projects/1", {}); add("detail enrolled token", "GET", "/projects/1", { authorization: "Bearer 7" }); add("detail 404", "GET", "/projects/99", {});
add("create", "POST", "/projects", MOD, { name: "New", description: "d", tier: "3", xpPrice: "2.5", tutorialSteps: [1], badges: ["b"] }); add("create no name", "POST", "/projects", MOD, {}); add("create raw fields", "POST", "/projects", ADM, { name: "R", projectType: "quest", deadline: "2026-12-01" });
add("create raw snake row", "POST", "/projects", ADM, { name: "R", projectType: "quest" }, { raw: "snake" }); add("create deadline injection text (PRJ-ISSUE-1)", "POST", "/projects", ADM, { name: "I", deadline: "2026-01-01'; DROP TABLE x; --" });
add("patch startedAt/deadline with quote (PRJ-ISSUE-1)", "PATCH", "/projects/2", ADM, { startedAt: "2026-04-04' OR '1'='1", deadline: "d'x" });
add("create plain user", "POST", "/projects", { ...U7, ...J }, { name: "x" });
add("patch fields", "PATCH", "/projects/1", ADM, { name: "Renamed", tier: "5" }); add("patch raw", "PATCH", "/projects/2", ADM, { status: "pa'used", deadline: "2026-05-05", exchangeCustomCategories: ["a'b"] }); add("patch 404", "PATCH", "/projects/99", ADM, { name: "z" }); add("patch empty", "PATCH", "/projects/1", ADM, {}); add("patch db failure", "PATCH", "/projects/1", ADM, { name: "x" }, { fail: "projects" });
add("delete project", "DELETE", "/projects/1", ADM); add("delete non-admin", "DELETE", "/projects/1", U7);
// join / enroll
add("join new", "POST", "/projects/3/join", U7); add("join existing", "POST", "/projects/1/join", U7); add("join unauth", "POST", "/projects/1/join", {});
add("enroll create (v11 -> p2)", "POST", "/projects/2/enroll", u7, { vaultEntryId: 11 }); add("enroll create + accountData + dataEntity", "POST", "/projects/3/enroll", u7, { vaultEntryId: 11, accountData: { twitter: "x" }, dataEntityId: 9 });
add("enroll create accountData non-object", "POST", "/projects/3/enroll", u7, { vaultEntryId: 11, accountData: "str" }); add("enroll create joins project if not joined", "POST", "/projects/3/enroll", u7, { vaultEntryId: 11 });
add("enroll reactivate disqualified (v10 p2)", "POST", "/projects/2/enroll", u7, { vaultEntryId: 10, accountData: { n: 1 }, kycEntryId: undefined }); add("enroll reactivate cancelled keeps data", "POST", "/projects/3/enroll", u7, { vaultEntryId: 10 });
add("enroll banned -> 403", "POST", "/projects/1/enroll", u7, { vaultEntryId: 11 }); add("enroll already active -> 409", "POST", "/projects/1/enroll", u7, { vaultEntryId: 10 });
add("enroll via KYC ok", "POST", "/projects/2/enroll", u7, { vaultEntryId: 11, kycEntryId: 5 }); add("enroll via KYC missing -> 404", "POST", "/projects/2/enroll", u7, { vaultEntryId: 11, kycEntryId: 99 });
add("enroll KYC in use elsewhere -> 409", "POST", "/projects/2/enroll", u8, { vaultEntryId: 20, kycEntryId: 6, dataEntityId: 1 }); add("enroll KYC same entity reuse", "POST", "/projects/3/enroll", u8, { vaultEntryId: 20, kycEntryId: 6 });
add("enroll NOT owned entity (gate 404)", "POST", "/projects/2/enroll", u7, { vaultEntryId: 20 }); add("enroll missing vaultEntryId (gate 404)", "POST", "/projects/2/enroll", u7, {}); add("enroll no credits -> 402", "POST", "/projects/2/enroll", { ...u7, "x-nocredit": "1" }, { vaultEntryId: 11 });
add("enroll charge not ok", "POST", "/projects/2/enroll", u7, { vaultEntryId: 11 }, { noCharge: true }); add("enroll unauth", "POST", "/projects/2/enroll", J, { vaultEntryId: 11 });
// status / lists
add("status disqualify", "PATCH", "/projects/1/enrollments/1/status", MOD, { status: "disqualified", reason: "spam" }); add("status restore", "PATCH", "/projects/1/enrollments/2/status", MOD, { status: "active" }); add("status ban no reason", "PATCH", "/projects/1/enrollments/1/status", ADM, { status: "banned" });
add("status prototype key toString (PRJ-ISSUE-3)", "PATCH", "/projects/1/enrollments/1/status", MOD, { status: "toString" }); add("status prototype key constructor", "PATCH", "/projects/1/enrollments/1/status", MOD, { status: "constructor" });
add("status invalid", "PATCH", "/projects/1/enrollments/1/status", MOD, { status: "nope" }); add("status 404", "PATCH", "/projects/1/enrollments/99/status", MOD, { status: "cancelled" }); add("status plain user", "PATCH", "/projects/1/enrollments/1/status", u7, { status: "banned" });
add("admin entity-enrollments", "GET", "/admin/projects/1/entity-enrollments", ADM); add("admin entity-enrollments db failure", "GET", "/admin/projects/1/entity-enrollments", ADM, null, { fail: "project_enrollments" }); add("admin entity-enrollments plain user", "GET", "/admin/projects/1/entity-enrollments", U7);
add("my enrollments p1", "GET", "/projects/1/enrollments", U7); add("my enrollments p2", "GET", "/projects/2/enrollments", U7); add("my enrollments none", "GET", "/projects/1/enrollments", U9);
// mine / overview
add("mine/enrolled", "GET", "/projects/mine/enrolled", U7); add("mine/overview", "GET", "/projects/mine/overview", U7); add("mine/overview failure", "GET", "/projects/mine/overview", U7, null, { fail: "activity" }); add("mine/entities-overview", "GET", "/projects/mine/entities-overview", U7); add("enrollments/overview", "GET", "/projects/1/enrollments/overview", U7); add("enrollments/overview failure", "GET", "/projects/1/enrollments/overview", U7, null, { fail: "activity" });
// delete / activity
add("leave own", "DELETE", "/projects/1/enrollments/1", U7); add("leave NOT own (gate silent)", "DELETE", "/projects/1/enrollments/4", U7); add("leave missing id (gate silent)", "DELETE", "/projects/1/enrollments/99", U7); add("leave NaN", "DELETE", "/projects/1/enrollments/abc", U7);
add("activity own", "GET", "/projects/enrollments/1/activity", U7); add("activity NOT own (gate 404)", "GET", "/projects/enrollments/4/activity", U7); add("activity missing", "GET", "/projects/enrollments/99/activity", U7); add("activity failure", "GET", "/projects/enrollments/1/activity", U7, null, { fail: "activity" });
// members / stats / entity-tasks
add("members", "GET", "/projects/1/members", ADM); add("members plain user", "GET", "/projects/1/members", U7); add("members failure", "GET", "/projects/1/members", ADM, null, { fail: "projects" }); add("stats", "GET", "/projects/1/stats", {}); add("stats p2", "GET", "/projects/2/stats", {}); add("entity-tasks", "GET", "/projects/1/entity-tasks", U7); add("entity-tasks failure", "GET", "/projects/1/entity-tasks", U7, null, { fail: "projects" });
// ratings
add("ratings list", "GET", "/projects/1/ratings", {}); add("ratings me", "GET", "/projects/1/ratings/me", U7); add("rating create", "POST", "/projects/2/ratings", u7, { rating: 4, comment: "ok" }); add("rating update", "POST", "/projects/1/ratings", u7, { rating: 3 }); add("rating invalid", "POST", "/projects/1/ratings", u7, { rating: 9 }); add("rating unknown project", "POST", "/projects/77/ratings", u7, { rating: 4 });
add("rating delete me", "DELETE", "/projects/1/ratings/me", U7); add("rating admin delete", "DELETE", "/admin/projects/1/ratings/2", ADM);
// roi / receipts
add("roi-summary", "GET", "/projects/1/roi-summary", U7); add("mint existing", "POST", "/projects/1/pnl-receipt", U7); add("mint new", "POST", "/projects/2/pnl-receipt", U7); add("mint unknown project", "POST", "/projects/55/pnl-receipt", U7); add("mint NaN", "POST", "/projects/abc/pnl-receipt", U7);
add("revoke", "DELETE", "/projects/1/pnl-receipt", U7); add("revoke none", "DELETE", "/projects/2/pnl-receipt", U7); add("public receipt", "GET", "/projects/pnl-receipt/tok-p1", {}); add("public receipt invalid", "GET", "/projects/pnl-receipt/nope", {}); add("public receipt orphan", "GET", "/projects/pnl-receipt/tok-orphan", {}); add("public pdf", "GET", "/projects/pnl-receipt/tok-p1/pdf", {}); add("public pdf invalid", "GET", "/projects/pnl-receipt/nope/pdf", {});
async function run(file) {
  const mod = await import(file); const app = express(); app.use(express.json()); app.use(mod.default);
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); }); const port = srv.address().port; const out = []; const st = mod.state;
  for (const c of C) {
    seed(st, c.opt ?? {});
    const res = await fetch(`http://127.0.0.1:${port}${c.url}`, { method: c.method, headers: c.headers, body: c.body !== undefined && c.body !== null ? JSON.stringify(c.body) : undefined });
    const text = await res.text(); await new Promise((r) => setTimeout(r, 12));
    out.push({ name: c.name, status: res.status, body: nz(text), sql: JSON.stringify(st.sqlLog), activity: JSON.stringify(st.activity), charges: JSON.stringify(st.charges), pep: JSON.stringify(st.pep), audits: JSON.stringify(st.audits), events: JSON.stringify(st.events), telegram: JSON.stringify(st.telegram), synced: JSON.stringify(st.synced), pdf: JSON.stringify(st.pdf), rows: nz(JSON.stringify(st.rows)) });
  }
  srv.close(); return out;
}
const a = await run(`${process.cwd()}/old.mjs`), b = await run(`${process.cwd()}/new.mjs`);
const EXPECT = new Set(["mine/enrolled-entities (was shadowed, PRJ-06)", "status prototype key toString (PRJ-ISSUE-3)", "status prototype key constructor", "create deadline injection text (PRJ-ISSUE-1)", "patch startedAt/deadline with quote (PRJ-ISSUE-1)"]);
let d = 0, expectedSeen = 0;
a.forEach((x, i) => { const y = b[i]; const differs = JSON.stringify(x) !== JSON.stringify(y); const expected = EXPECT.has(x.name);
  if (differs && expected) { expectedSeen++; console.log("EXPECTED DIFF", x.name, "\n  old:", x.status, x.body.slice(0, 110), "\n  new:", y.status, y.body.slice(0, 110), "\n  sql changed:", x.sql !== y.sql); }
  else if (differs) { d++; const k = Object.keys(x).find((key) => x[key] !== y[key]); console.log("UNEXPECTED DIFF", x.name, "field:", k, "\n old", String(x[k]).slice(0, 240), "\n new", String(y[k]).slice(0, 240)); }
  else if (expected) { d++; console.log("MISSING EXPECTED DIFF (fix not effective?)", x.name); } });
console.log(`whole-file: ${a.length} scenarios, ${a.length - expectedSeen - d} identical, ${expectedSeen} intended differences, ${d} unexpected`);
console.log("statuses:", [...new Set(a.map((x) => x.status))].sort().join(","));
console.log("with SQL:", a.filter((x) => x.sql !== "[]").length, "| activity-log writes:", a.filter((x) => x.activity !== "[]").length, "| credit charges:", a.filter((x) => x.charges !== "[]").length, "| PEP gate checks:", a.filter((x) => x.pep !== "[]").length, "| KYC audits:", a.filter((x) => x.audits !== "[]").length);
process.exit(d ? 1 : 0);
