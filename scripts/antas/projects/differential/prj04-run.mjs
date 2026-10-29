process.env.NODE_ENV = "production";
import "express-async-errors";
import express from "express";
const D = (s) => new Date(s);
const U7 = { "x-user": "7" }, U8 = { "x-user": "8" }, J = { "content-type": "application/json" };
const tok = (n) => Buffer.from(`T${n}`.padEnd(20, "x")).toString("base64url");
const seed = (st, fail = null, opt = {}) => {
  st.rows = { projects: [], users: [], entity_project_roi: [], vault_entries: [], project_pnl_receipts: [], finance_ledger_entries: [] };
  st.nextId = 900; st.failTable = fail; st.pdf.length = 0; st.tokenCounter = 0;
  const c = D("2026-01-01T00:00:00Z"), r = st.rows;
  r.projects.push({ id: 1, name: "Alpha", tier: "2", thumbnailUrl: "a.png" }, { id: 2, name: "Beta", tier: null, thumbnailUrl: null }, { id: 3, name: "Gamma", tier: "1", thumbnailUrl: null });
  r.users.push({ id: 7, username: "alice" }, { id: 8, username: "bob" });
  r.vault_entries.push({ id: 10, entitySerial: "E-10", projectName: "Entity Ten" });
  r.entity_project_roi.push(
    { id: 1, userId: 7, projectId: 1, vaultEntryId: 10, totalProfit: 100.5, totalCost: 40.25, roi: null, recordedAt: D("2026-02-01T00:00:00Z") },
    { id: 2, userId: 7, projectId: 1, vaultEntryId: 11, totalProfit: 9, totalCost: 1, roi: 0, recordedAt: D("2026-02-02T00:00:00Z") },
    { id: 3, userId: 7, projectId: 1, vaultEntryId: 12, totalProfit: 1, totalCost: 9, roi: 7.5, recordedAt: D("2026-02-03T00:00:00Z") },
    { id: 4, userId: 8, projectId: 1, vaultEntryId: 10, totalProfit: 999, totalCost: 1, roi: null, recordedAt: D("2026-02-04T00:00:00Z") });
  const L = (id, userId, projectId, kind, amount) => r.finance_ledger_entries.push({ id, userId, projectId, kind, amount });
  L(1, 7, 1, "investment", 100.4); L(2, 7, 1, "expense", 40.1); L(3, 7, 1, "income", 70.2); L(4, 7, 1, "income", 0.1); L(5, 7, 1, "income", 0.2); L(6, 7, 1, "transfer", 5000); L(7, 8, 1, "income", 777);
  L(8, 7, 2, "income", 12.5);                                  // earned only -> roiPct 100
  L(9, 7, 3, "investment", 30);                                // invested only -> roiPct null, hero is net P&L
  r.project_pnl_receipts.push({ id: 1, userId: 7, projectId: 1, receiptToken: "tok-p1-u7", createdAt: c }, { id: 2, userId: 7, projectId: 2, receiptToken: "tok-p2", createdAt: c },
    { id: 3, userId: 7, projectId: 3, receiptToken: "tok-p3", createdAt: c }, { id: 4, userId: 7, projectId: 77, receiptToken: "tok-orphan", createdAt: c }, { id: 5, userId: 55, projectId: 1, receiptToken: "tok-ghost-user", createdAt: c });
  if (opt.clearReceipts) r.project_pnl_receipts.length = 0;
  if (opt.collideN) for (let i = 1; i <= opt.collideN; i++) r.project_pnl_receipts.push({ id: 100 + i, userId: 99, projectId: 99, receiptToken: tok(i), createdAt: c });
};
const nz = (t) => t.replace(/"generatedAt":"[^"]+"/g, '"generatedAt":"NOW"');
const cases = [
  ["roi mixed rows", "GET", "/projects/1/roi-summary", U7], ["roi other user", "GET", "/projects/1/roi-summary", U8], ["roi empty", "GET", "/projects/2/roi-summary", U7], ["roi NaN id", "GET", "/projects/abc/roi-summary", U7],
  ["roi unauth", "GET", "/projects/1/roi-summary", {}], ["roi db failure", "GET", "/projects/1/roi-summary", U7, null, "entity_project_roi"],
  ["mint existing", "POST", "/projects/1/pnl-receipt", U7], ["mint idempotent twice (2nd shown)", "POST", "/projects/2/pnl-receipt", U7],
  ["mint new", "POST", "/projects/1/pnl-receipt", U8], ["mint new then again", "POST", "/projects/3/pnl-receipt", U8, null, null, { clearReceipts: true }],
  ["mint collision once", "POST", "/projects/1/pnl-receipt", U8, null, null, { collideN: 1 }], ["mint collision twice", "POST", "/projects/1/pnl-receipt", U8, null, null, { collideN: 2 }],
  ["mint collision thrice -> 500", "POST", "/projects/1/pnl-receipt", U8, null, null, { collideN: 3 }], ["mint unknown project", "POST", "/projects/55/pnl-receipt", U7], ["mint NaN", "POST", "/projects/abc/pnl-receipt", U7],
  ["mint unauth", "POST", "/projects/1/pnl-receipt", {}], ["mint db failure", "POST", "/projects/1/pnl-receipt", U7, null, "projects"], ["mint insert failure (non-collision)", "POST", "/projects/1/pnl-receipt", U8, null, "project_pnl_receipts"],
  ["revoke ok", "DELETE", "/projects/1/pnl-receipt", U7], ["revoke none", "DELETE", "/projects/1/pnl-receipt", U8], ["revoke NaN", "DELETE", "/projects/abc/pnl-receipt", U7], ["revoke unauth", "DELETE", "/projects/1/pnl-receipt", {}],
  ["public mixed kinds + float sums", "GET", "/projects/pnl-receipt/tok-p1-u7", {}], ["public earned only", "GET", "/projects/pnl-receipt/tok-p2", {}], ["public invested only", "GET", "/projects/pnl-receipt/tok-p3", {}],
  ["public invalid token", "GET", "/projects/pnl-receipt/nope", {}], ["public orphan project", "GET", "/projects/pnl-receipt/tok-orphan", {}], ["public missing issuer", "GET", "/projects/pnl-receipt/tok-ghost-user", {}],
  ["public db failure", "GET", "/projects/pnl-receipt/tok-p1-u7", {}, null, "finance_ledger_entries"],
  ["pdf mixed", "GET", "/projects/pnl-receipt/tok-p1-u7/pdf", {}], ["pdf earned only", "GET", "/projects/pnl-receipt/tok-p2/pdf", {}], ["pdf invested only (no tier on p2? p3 tier 1)", "GET", "/projects/pnl-receipt/tok-p3/pdf", {}],
  ["pdf invalid", "GET", "/projects/pnl-receipt/nope/pdf", {}], ["pdf orphan", "GET", "/projects/pnl-receipt/tok-orphan/pdf", {}],
  ["public after revoke (sequence not supported: fresh seed)", "GET", "/projects/pnl-receipt/tok-p1-u7", {}],
];
async function run(file) {
  const mod = await import(file); const app = express(); app.use(express.json()); app.use(mod.default);
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); }); const port = srv.address().port; const out = [];
  for (const [name, method, url, headers, body, fail, opt] of cases) {
    seed(mod.state, fail ?? null, opt ?? {});
    let text, status;
    const first = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    status = first.status; text = await first.text();
    if (name.includes("idempotent twice") || name.includes("then again")) { const second = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers }); text += " || " + second.status + " " + await second.text(); }
    out.push({ name, status, body: nz(text), pdf: JSON.stringify(mod.state.pdf), rows: JSON.stringify(mod.state.rows.project_pnl_receipts) });
  }
  srv.close(); return out;
}
const a = await run(`${process.cwd()}/old.mjs`), b = await run(`${process.cwd()}/new.mjs`);
let d = 0; a.forEach((x, i) => { if (JSON.stringify(x) !== JSON.stringify(b[i])) { d++; console.log("DIFF", x.name, "\n old", x.status, x.body.slice(0, 260), "\n new", b[i].status, b[i].body.slice(0, 260)); } });
console.log(`roi+receipts: ${a.length} scenarios, ${a.length - d} identical, ${d} different`); console.log("statuses:", [...new Set(a.map((x) => x.status))].sort().join(","));
console.log("pdf specs captured in:", a.filter((x) => x.pdf !== "[]").length, "scenarios");
process.exit(d ? 1 : 0);
