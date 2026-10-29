import express from "express";
const D = (s) => new Date(s);
const seed = (state) => {
  state.rows = { project_dates: [], projects: [], project_enrollments: [] }; state.nextId = 100; state.fail = false; state.logs = [];
  state.rows.projects.push({ id: 1, name: "Alpha", thumbnailUrl: "a.png" }, { id: 2, name: "Beta", thumbnailUrl: null });
  const base = { notes: null, remindedAt: null, createdAt: D("2026-01-01T00:00:00Z") };
  state.rows.project_dates.push(
    { id: 1, projectId: 1, label: "Snapshot", eventType: "snapshot", eventDate: D("2099-03-01T00:00:00Z"), ...base },
    { id: 2, projectId: 2, label: "TGE", eventType: "tge", eventDate: D("2099-01-01T00:00:00Z"), ...base, notes: "n", remindedAt: D("2026-02-01T00:00:00Z") },
    { id: 3, projectId: 1, label: "Old", eventType: "claim", eventDate: D("2000-01-01T00:00:00Z"), ...base },
    { id: 4, projectId: 99, label: "Orphan", eventType: "other", eventDate: D("2099-02-01T00:00:00Z"), ...base });
  state.rows.project_enrollments.push({ id: 1, userId: 7, projectId: 1 }, { id: 2, userId: 7, projectId: 1 });
};
const U = { "x-user": "7" }, A = { "x-user": "7", "x-admin": "1" };
const J = { "content-type": "application/json" };
const scenarios = [
  ["calendar all", "GET", "/project-dates", U],
  ["calendar mine", "GET", "/project-dates?mine=true", U],
  ["calendar mine, no enrollments", "GET", "/project-dates?mine=true", { "x-user": "8" }],
  ["calendar upcomingOnly", "GET", "/project-dates?upcomingOnly=true", U],
  ["calendar mine+upcoming", "GET", "/project-dates?mine=true&upcomingOnly=true", U],
  ["calendar unauthenticated", "GET", "/project-dates", {}],
  ["calendar db failure", "GET", "/project-dates", U, null, true],
  ["project dates p1", "GET", "/projects/1/dates", U],
  ["project dates unknown", "GET", "/projects/55/dates", U],
  ["project dates NaN", "GET", "/projects/abc/dates", U],
  ["create valid", "POST", "/projects/1/dates", { ...A, ...J }, { label: "  New  ", eventDate: "2099-05-01T00:00:00Z" }],
  ["create full", "POST", "/projects/2/dates", { ...A, ...J }, { label: "X", eventType: "tge", eventDate: "2099-05-01", notes: "hi" }],
  ["create empty notes/type", "POST", "/projects/1/dates", { ...A, ...J }, { label: "Y", eventType: "", eventDate: "2099-05-01", notes: "" }],
  ["create no label", "POST", "/projects/1/dates", { ...A, ...J }, { eventDate: "2099-05-01" }],
  ["create blank label", "POST", "/projects/1/dates", { ...A, ...J }, { label: "  ", eventDate: "2099-05-01" }],
  ["create no date", "POST", "/projects/1/dates", { ...A, ...J }, { label: "L" }],
  ["create bad date", "POST", "/projects/1/dates", { ...A, ...J }, { label: "L", eventDate: "zzz" }],
  ["create non-admin", "POST", "/projects/1/dates", { ...U, ...J }, { label: "L", eventDate: "2099-05-01" }],
  ["create db failure", "POST", "/projects/1/dates", { ...A, ...J }, { label: "L", eventDate: "2099-05-01" }, true],
  ["patch label", "PATCH", "/project-dates/1", { ...A, ...J }, { label: " Renamed " }],
  ["patch date resets reminder", "PATCH", "/project-dates/2", { ...A, ...J }, { eventDate: "2099-09-09T00:00:00Z" }],
  ["patch notes+type", "PATCH", "/project-dates/1", { ...A, ...J }, { notes: "", eventType: "claim" }],
  ["patch bad date", "PATCH", "/project-dates/1", { ...A, ...J }, { eventDate: "nope" }],
  ["patch not found", "PATCH", "/project-dates/777", { ...A, ...J }, { label: "x" }],
  ["patch empty body", "PATCH", "/project-dates/1", { ...A, ...J }, {}],
  ["patch non-admin", "PATCH", "/project-dates/1", { ...U, ...J }, { label: "x" }],
  ["patch db failure", "PATCH", "/project-dates/1", { ...A, ...J }, { label: "x" }, true],
  ["delete ok", "DELETE", "/project-dates/1", A],
  ["delete not found", "DELETE", "/project-dates/777", A],
  ["delete non-admin", "DELETE", "/project-dates/1", U],
];
async function runVariant(file) {
  const mod = await import(file); const state = mod.state;
  const app = express(); app.use(express.json()); app.use(mod.default);
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const port = srv.address().port, out = [];
  for (const [name, method, url, headers, body, fail] of scenarios) {
    seed(state); state.fail = Boolean(fail);
    const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    out.push({ name, status: res.status, body: text, logs: [...state.logs], rows: JSON.stringify(state.rows.project_dates) });
  }
  srv.close(); return out;
}
const a = await runVariant(`${process.cwd()}/old.mjs`), b = await runVariant(`${process.cwd()}/new.mjs`);
let bad = 0;
a.forEach((x, i) => { const y = b[i]; const same = JSON.stringify(x) === JSON.stringify(y); if (!same) { bad++; console.log("DIFF", x.name, "\n old", x, "\n new", y); } });
console.log(`scenarios: ${a.length}; identical: ${a.length - bad}; different: ${bad}`);
console.log("sample statuses:", a.map((x) => `${x.name}=${x.status}`).join(" | "));
process.exit(bad ? 1 : 0);
