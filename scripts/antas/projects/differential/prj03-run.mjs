process.env.NODE_ENV = "production";
import "express-async-errors";
import express from "express";
const D = (s) => new Date(s);
const U7 = { "x-user": "7" }, A = { "x-user": "9", "x-admin": "1" }, J = { "content-type": "application/json" };
const seedRatings = (st) => {
  const r = st.rows; for (const k of Object.keys(r)) r[k].length = 0; st.nextId = 1000; st.events.length = 0; st.failTable = null;
  r.projects.push({ id: 1, name: "Alpha" }, { id: 2, name: "Beta" });
  r.users.push({ id: 7, username: "alice" }, { id: 8, username: "bob" });
  const c = D("2026-01-01T00:00:00Z");
  r.project_ratings.push(
    { id: 1, projectId: 1, userId: 7, rating: 5, comment: "great", createdAt: c, updatedAt: D("2026-02-01T00:00:00Z") },
    { id: 2, projectId: 1, userId: 8, rating: 2, comment: null, createdAt: c, updatedAt: D("2026-03-01T00:00:00Z") },
    { id: 3, projectId: 1, userId: 55, rating: 4, comment: "ghost user", createdAt: c, updatedAt: D("2026-01-15T00:00:00Z") });
};
const rs = [
  ["list p1", "GET", "/projects/1/ratings", {}], ["list empty p2", "GET", "/projects/2/ratings", {}], ["list NaN", "GET", "/projects/x/ratings", {}], ["list db failure", "GET", "/projects/1/ratings", {}, null, "users"],
  ["me none", "GET", "/projects/2/ratings/me", U7], ["me existing", "GET", "/projects/1/ratings/me", U7], ["me unauth", "GET", "/projects/1/ratings/me", {}],
  ["post new 201", "POST", "/projects/2/ratings", { ...U7, ...J }, { rating: 4, comment: "ok" }],
  ["post update 200", "POST", "/projects/1/ratings", { ...U7, ...J }, { rating: 3 }],
  ["post comment null", "POST", "/projects/2/ratings", { ...U7, ...J }, { rating: 1, comment: null }],
  ...[["str5", "5"], ["true", true], ["zero", 0], ["six", 6], ["frac", 3.5], ["abc", "abc"], ["null", null], ["empty", ""], ["missing", undefined], ["neg", -1], ["float-int", 4.0]].map(([n, v]) => [`post rating ${n}`, "POST", "/projects/2/ratings", { ...U7, ...J }, { rating: v }]),
  ["post unknown project", "POST", "/projects/77/ratings", { ...U7, ...J }, { rating: 4 }], ["post unauth", "POST", "/projects/1/ratings", J, { rating: 4 }],
  ["post db failure", "POST", "/projects/2/ratings", { ...U7, ...J }, { rating: 4 }, "project_ratings"],
  ["delete me", "DELETE", "/projects/1/ratings/me", U7], ["delete me none", "DELETE", "/projects/2/ratings/me", U7],
  ["admin delete", "DELETE", "/admin/projects/1/ratings/2", A], ["admin delete missing", "DELETE", "/admin/projects/1/ratings/999", A], ["admin delete non-admin", "DELETE", "/admin/projects/1/ratings/2", U7],
];
const seedTpl = (st) => {
  const r = st.rows; for (const k of Object.keys(r)) r[k].length = 0; st.nextId = 1000; st.events.length = 0; st.failTable = null;
  const c = D("2026-01-01T00:00:00Z");
  r.templates.push(
    { id: 1, name: "Exchange", description: "d", data: JSON.stringify({ tier: "gold", projectType: "exchange" }), folder: "F", usageCount: 2, defaultForProjectType: "exchange", createdBy: 1, createdAt: c, updatedAt: D("2026-02-01T00:00:00Z") },
    { id: 2, name: "Quest", description: null, data: "not json", folder: null, usageCount: 0, defaultForProjectType: null, createdBy: 1, createdAt: c, updatedAt: D("2026-03-01T00:00:00Z") },
    { id: 3, name: "Copy of Exchange", description: null, data: "{}", folder: null, usageCount: 0, defaultForProjectType: null, createdBy: 1, createdAt: c, updatedAt: D("2026-01-05T00:00:00Z") });
  r.projects.push({ id: 5, name: "Proj", category: "defi", project_type: "quest", exchange_sub_type: null, account_category: "", tier: "silver", experience_level: "beginner", duration_type: "weeks", difficulty: "hard", cost_type: "free", xp_name: "TXP", xp_price: 1.5, tutorial_link: "http://t", tutorial_steps: '["a","b"]', badges: "oops{", secret: "x" });
};
const AD = { "x-user": "9", "x-role": "admin" }, DEV = { "x-user": "9", "x-role": "dev" };
const ts = [
  ["list", "GET", "/project-templates", DEV], ["list unauth", "GET", "/project-templates", {}], ["list wrong role", "GET", "/project-templates", { "x-user": "9", "x-role": "user" }],
  ["get", "GET", "/project-templates/1", DEV], ["get corrupt data", "GET", "/project-templates/2", DEV], ["get 404", "GET", "/project-templates/99", DEV], ["get NaN", "GET", "/project-templates/abc", DEV],
  ["create", "POST", "/project-templates", { ...AD, ...J }, { name: "  New  ", description: " desc ", folder: " f ", data: { tier: "x", evil: 1, badges: ["a"], xpName: "", category: null } }],
  ["create default steals slot", "POST", "/project-templates", { ...AD, ...J }, { name: "N2", defaultForProjectType: "exchange" }],
  ["create dup name 409", "POST", "/project-templates", { ...AD, ...J }, { name: "quest" }],
  ["create dup name+default (rollback)", "POST", "/project-templates", { ...AD, ...J }, { name: "QUEST", defaultForProjectType: "exchange" }],
  ["create no name", "POST", "/project-templates", { ...AD, ...J }, { description: "x" }], ["create blank name", "POST", "/project-templates", { ...AD, ...J }, { name: "  " }], ["create non-string name", "POST", "/project-templates", { ...AD, ...J }, { name: 5 }],
  ["create bad description type", "POST", "/project-templates", { ...AD, ...J }, { name: "Z", description: 5 }],
  ["create dev forbidden", "POST", "/project-templates", { ...DEV, ...J }, { name: "Z" }],
  ["patch name", "PATCH", "/project-templates/2", { ...AD, ...J }, { name: " Renamed ", description: " d ", folder: "", data: { tier: "t", junk: 1 } }],
  ["patch default moves", "PATCH", "/project-templates/2", { ...AD, ...J }, { defaultForProjectType: "exchange" }],
  ["patch default null", "PATCH", "/project-templates/1", { ...AD, ...J }, { defaultForProjectType: "" }],
  ["patch name empty 400", "PATCH", "/project-templates/1", { ...AD, ...J }, { name: "  " }], ["patch 404", "PATCH", "/project-templates/99", { ...AD, ...J }, { name: "x" }],
  ["patch clash 409", "PATCH", "/project-templates/2", { ...AD, ...J }, { name: "exchange" }], ["patch clash+default rollback", "PATCH", "/project-templates/2", { ...AD, ...J }, { name: "EXCHANGE", defaultForProjectType: "exchange" }],
  ["patch no fields", "PATCH", "/project-templates/1", { ...AD, ...J }, {}],
  ["delete", "DELETE", "/project-templates/1", AD], ["delete 404", "DELETE", "/project-templates/99", AD],
  ["apply", "POST", "/project-templates/1/apply", AD], ["apply 404", "POST", "/project-templates/99/apply", AD],
  ["duplicate clash suffix", "POST", "/project-templates/1/duplicate", AD], ["duplicate plain", "POST", "/project-templates/2/duplicate", AD], ["duplicate 404", "POST", "/project-templates/99/duplicate", AD],
  ["from-project", "POST", "/project-templates/from-project/5", { ...AD, ...J }, { name: "FromP", folder: " ff " }],
  ["from-project custom description", "POST", "/project-templates/from-project/5", { ...AD, ...J }, { name: "FromP2", description: " mine " }],
  ["from-project 404", "POST", "/project-templates/from-project/99", { ...AD, ...J }, { name: "x" }], ["from-project no name", "POST", "/project-templates/from-project/5", { ...AD, ...J }, {}],
  ["from-project name clash", "POST", "/project-templates/from-project/5", { ...AD, ...J }, { name: "Quest" }],
  ["db failure list", "GET", "/project-templates", DEV, null, "templates"],
];
async function run(file, seed, cases) {
  const mod = await import(file); const app = express(); app.use(express.json()); app.use(mod.default);
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); }); const port = srv.address().port; const out = [];
  for (const [name, method, url, headers, body, fail] of cases) {
    seed(mod.state); mod.state.failTable = fail ?? null;
    const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers, body: body !== undefined && body !== null ? JSON.stringify(body) : undefined });
    const nz = (t) => t.replace(/"2026-10-\d\dT[\d:.]+Z"/g, '"NOW"');
    out.push({ name, status: res.status, body: nz(await res.text()), events: JSON.stringify(mod.state.events), rows: nz(JSON.stringify(mod.state.rows)) });
  }
  srv.close(); return out;
}
let bad = 0, total = 0;
for (const [label, o, n, seed, cases] of [["ratings", "rold", "rnew", seedRatings, rs], ["templates", "told", "tnew", seedTpl, ts]]) {
  const a = await run(`${process.cwd()}/${o}.mjs`, seed, cases), b = await run(`${process.cwd()}/${n}.mjs`, seed, cases);
  let d = 0; a.forEach((x, i) => { if (JSON.stringify(x) !== JSON.stringify(b[i])) { d++; console.log("DIFF", label, x.name, "\n old", x.status, x.body.slice(0, 200), "\n new", b[i].status, b[i].body.slice(0, 200)); } });
  console.log(`${label}: ${a.length} scenarios, ${a.length - d} identical, ${d} different`); bad += d; total += a.length;
  console.log("  statuses:", [...new Set(a.map((x) => x.status))].sort().join(","));
}
process.exit(bad ? 1 : 0);
