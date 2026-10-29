process.env.NODE_ENV = "production";
import "express-async-errors";
import express from "express";
const D = (s) => new Date(s);
const ADM = { "x-user": "1", "x-admin": "1", "x-role": "admin", "content-type": "application/json" }, MOD = { "x-user": "2", "x-role": "moderator", "content-type": "application/json" }, USR = { "x-user": "3", "content-type": "application/json" };
const seed = (st, mode = "camel", fail = null) => {
  st.rows = { projects: [], tasks: [], user_projects: [], project_enrollments: [] }; st.nextId = 500; st.events.length = 0; st.sqlLog.length = 0; st.telegram.length = 0; st.synced.length = 0; st.failTable = fail; st.rawMode = mode;
  const c = D("2026-01-01T00:00:00Z");
  st.rows.projects.push({ id: 1, name: "Alpha Protocol", tier: "1", createdAt: c, xpPrice: 0.01 }, { id: 2, name: "beta quest", tier: "2", createdAt: c, xpPrice: 0.5 }, { id: 3, name: "Gamma", tier: "1", createdAt: c, xpPrice: 1 });
  st.rows.tasks.push({ id: 1, projectId: 1, title: "t1", createdAt: c }, { id: 2, projectId: 1, title: "t2", createdAt: c }, { id: 3, projectId: 2, title: "t3", createdAt: c });
  st.rows.user_projects.push({ userId: 7, projectId: 1 }, { userId: 8, projectId: 1 }, { userId: 7, projectId: 2 });
  st.rows.project_enrollments.push({ id: 1, projectId: 1, userId: 7 }, { id: 2, projectId: 1, userId: 7 }, { id: 3, projectId: 2, userId: 8 });
};
const J = (o) => JSON.stringify(o);
const cases = [
  ["list default", "GET", "/projects", {}], ["list tier", "GET", "/projects?tier=2", {}], ["list search", "GET", "/projects?search=ALPHA", {}],
  ["list type+sub+acct raw", "GET", "/projects?type=defi'x&exchangeSubType=cex&accountCategory=ind'v", {}], ["list type all", "GET", "/projects?type=all&accountCategory=all", {}],
  ["list page2 limit1", "GET", "/projects?page=2&limit=1", {}], ["list limit 999", "GET", "/projects?limit=999", {}], ["list limit abc", "GET", "/projects?limit=abc", {}], ["list page 0", "GET", "/projects?page=0&limit=2", {}],
  ["list db failure", "GET", "/projects", {}, null, "projects"],
  ["detail 404", "GET", "/projects/99", {}], ["detail anon", "GET", "/projects/1", {}], ["detail with token enrolled", "GET", "/projects/1", { authorization: "Bearer 7" }],
  ["detail token not enrolled", "GET", "/projects/3", { authorization: "Bearer 7" }], ["detail bad token", "GET", "/projects/1", { authorization: "Bearer zzz" }], ["detail NaN", "GET", "/projects/abc", {}],
  ["create no name", "POST", "/projects", MOD, {}], ["create minimal", "POST", "/projects", MOD, { name: "New" }],
  ["create full", "POST", "/projects", ADM, { name: "Full", description: "d", xpName: "", xpPrice: "2.5", twitterHandle: "t", discordUrl: "d", websiteUrl: "w", tutorialLink: "l", tutorialSteps: [{ a: 1 }], badges: ["x"], experienceLevel: "Pro", tier: "3", fundingAmount: "10", rewardEstimate: 5, thumbnailUrl: "th", bannerUrl: "b" }],
  ["create strings steps/badges", "POST", "/projects", ADM, { name: "S", tutorialSteps: "[1]", badges: "b1,b2" }],
  ...[["xpPrice empty", ""], ["xpPrice null", null], ["xpPrice 0", 0]].map(([n, v]) => [`create ${n}`, "POST", "/projects", ADM, { name: "X", xpPrice: v }]),
  ["create raw fields", "POST", "/projects", ADM, { name: "R", category: "c'at", projectType: "quest", exchangeSubType: "s", accountCategory: "both", deadline: "2026-12-01", durationType: "wk", difficulty: "easy", costType: "paid" }],
  ["create deadline injection text", "POST", "/projects", ADM, { name: "I", deadline: "2026-01-01'; DROP TABLE x; --" }],
  ["create raw row snake_case (failure path)", "POST", "/projects", ADM, { name: "Snake", projectType: "quest" }, null, "snake"],
  ["create unauth", "POST", "/projects", { "content-type": "application/json" }, { name: "x" }], ["create plain user", "POST", "/projects", USR, { name: "x" }], ["create db failure", "POST", "/projects", ADM, { name: "x" }, "projects"],
  ["patch fields", "PATCH", "/projects/1", ADM, { name: "Renamed", tier: "5", xpPrice: 3 }], ["patch steps array + badges", "PATCH", "/projects/1", ADM, { tutorialSteps: [1, 2], badges: "b" }],
  ["patch empty body", "PATCH", "/projects/1", ADM, {}], ["patch 404 empty", "PATCH", "/projects/99", ADM, {}], ["patch 404 fields", "PATCH", "/projects/99", ADM, { name: "z" }],
  ["patch raw sets", "PATCH", "/projects/2", ADM, { status: "pa'used", projectType: "q", exchangeSubType: "s", accountCategory: "a", exchangeCustomCategories: ["a'b"], durationType: "d", difficulty: "h", costType: "c", category: "k" }],
  ["patch deadline/startedAt values", "PATCH", "/projects/2", ADM, { deadline: "2026-05-05", startedAt: "2026-04-04" }], ["patch deadline/startedAt null", "PATCH", "/projects/2", ADM, { deadline: null, startedAt: "" }],
  ["patch exchangeCustomCategories null", "PATCH", "/projects/2", ADM, { exchangeCustomCategories: null }], ["patch fields+raw", "PATCH", "/projects/1", ADM, { name: "Both", status: "live" }],
  ["patch raw snake row", "PATCH", "/projects/1", ADM, { status: "live" }, null, "snake"], ["patch db failure", "PATCH", "/projects/1", ADM, { name: "x" }, "projects"], ["patch non-admin", "PATCH", "/projects/1", USR, { name: "x" }],
  ["delete", "DELETE", "/projects/1", ADM], ["delete missing", "DELETE", "/projects/99", ADM], ["delete non-admin", "DELETE", "/projects/1", USR],
];
async function run(file) {
  const mod = await import(file); const app = express(); app.use(express.json()); app.use(mod.default);
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); }); const port = srv.address().port; const out = [];
  for (const [name, method, url, headers, body, fail, mode] of cases) {
    seed(mod.state, mode ?? "camel", fail ?? null);
    const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers, body: body !== undefined && body !== null ? J(body) : undefined });
    const text = await res.text(); await new Promise((r) => setTimeout(r, 15));
    out.push({ name, status: res.status, body: text, events: J(mod.state.events), sql: J(mod.state.sqlLog), telegram: J(mod.state.telegram), synced: J(mod.state.synced), rows: J(mod.state.rows) });
  }
  srv.close(); return out;
}
const a = await run(`${process.cwd()}/cold.mjs`), b = await run(`${process.cwd()}/cnew.mjs`);
let d = 0; a.forEach((x, i) => { if (J(x) !== J(b[i])) { d++; console.log("DIFF", x.name, "\n old", x.status, x.body.slice(0, 300), x.sql.slice(0, 300), "\n new", b[i].status, b[i].body.slice(0, 300), b[i].sql.slice(0, 300)); } });
console.log(`crud: ${a.length} scenarios, ${a.length - d} identical, ${d} different`); console.log("statuses:", [...new Set(a.map((x) => x.status))].sort().join(","));
console.log("sql-logged scenarios:", a.filter((x) => x.sql !== "[]").length, "| telegram-notified:", a.filter((x) => x.telegram !== "[]").length, "| synced:", a.filter((x) => x.synced !== "[]").length);
process.exit(d ? 1 : 0);
