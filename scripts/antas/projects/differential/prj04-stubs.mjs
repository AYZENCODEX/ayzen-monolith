export const state = { rows: {}, nextId: 900, failTable: null, pdf: [], tokenCounter: 0 };
const T = (name) => new Proxy({ __name: name }, { get: (t, k) => (k === "__name" ? name : { t: name, k }) });
export const projectsTable = T("projects"), usersTable = T("users"), entityProjectRoiTable = T("entity_project_roi"), vaultEntriesTable = T("vault_entries"),
  projectPnlReceiptsTable = T("project_pnl_receipts"), financeLedgerEntriesTable = T("finance_ledger_entries"), tasksTable = T("tasks"), userProjectsTable = T("user_projects");
const val = (x, c) => (x && x.t ? (c[x.t] ? c[x.t][x.k] : null) : x);
export const eq = (a, b) => (c) => val(a, c) === val(b, c);
export const and = (...p) => (c) => p.filter(Boolean).every((f) => typeof f === "function" ? f(c) : true);
export const ilike = () => () => true; export const count = () => ({ __count: true });
export const sql = Object.assign((s, ...v) => ({ __sql: true, text: s.join("?"), values: v }), { raw: (t) => ({ __raw: t }) });
const clone = (r) => ({ ...r });
const gate = (n) => { if (state.failTable === n) throw new Error("db down"); };
const ev = (p, c) => (p && p.__sql ? (p.text.includes(" IN (") ? ["investment", "expense", "income"].includes(c[Object.keys(c)[0]].kind) : true) : typeof p === "function" ? p(c) : true);
export const db = {
  select(fields) { const q = {}; const b = { from(t) { q.from = t.__name; return b; }, leftJoin(t, on) { q.join = { n: t.__name, on }; return b; }, where(p) { q.pred = p; return b; }, limit(n) { q.limit = n; return b; }, groupBy(g) { q.group = g; return b; },
    then(res, rej) { try { gate(q.from); let out = [];
      for (const r of state.rows[q.from]) { const c = { [q.from]: r }; if (q.join) c[q.join.n] = state.rows[q.join.n].find((j) => q.join.on({ ...c, [q.join.n]: j })) ?? null; if (ev(q.pred, c)) out.push(c); }
      if (fields && q.group) { const g = new Map(); for (const c of out) { const k = val(q.group, c); g.set(k, (g.get(k) ?? 0) + c[q.from].amount); } return res([...g].map(([kind, total]) => ({ kind, total }))); }
      if (q.limit !== undefined) out = out.slice(0, q.limit);
      res(out.map((c) => fields ? Object.fromEntries(Object.entries(fields).map(([k, ref]) => [k, ref && ref.__name ? clone(c[ref.__name]) : val(ref, c)])) : clone(c[q.from]))); } catch (e) { rej(e); } } }; return b; },
  insert: (t) => ({ values: (v) => ({ returning: async (f) => { gate(t.__name); if (t.__name === "project_pnl_receipts" && state.rows[t.__name].some((r) => r.receiptToken === v.receiptToken)) throw new Error("duplicate key receipt_token"); const row = { id: state.nextId++, createdAt: new Date("2026-01-01T00:00:00Z"), ...v }; state.rows[t.__name].push(row); return [f ? Object.fromEntries(Object.keys(f).map((k) => [k, row[k]])) : clone(row)]; } }) }),
  delete: (t) => ({ where: (p) => ({ returning: async () => { gate(t.__name); const keep = [], gone = []; for (const r of state.rows[t.__name]) (ev(p, { [t.__name]: r }) ? gone : keep).push(r); state.rows[t.__name] = keep; return gone.map((r) => ({ id: r.id })); } }) }),
};
export const requireAuth = (q, s, n) => { const u = q.header("x-user"); if (!u) { s.status(401).json({ error: "auth" }); return; } q.user = { userId: Number(u) }; n(); };
export const requirePublicAudit = () => (q, s, n) => n();
export const pepDecisionObserver = () => {};
export const streamFantasticReceiptPdf = (res, spec) => { state.pdf.push(spec); res.json({ pdf: spec }); };
export const randomBytes = (n) => Buffer.from(`T${++state.tokenCounter}`.padEnd(n, "x"));
export default { randomBytes };
