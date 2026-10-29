// Whole-file stubs for routes/projects.ts: db, drizzle, auth, PEP, credits, activity log, vault KYC helpers, etc.
export const state = { rows: {}, nextId: 2000, failTable: null, sqlLog: [], activity: [], charges: [], pep: [], audits: [], events: [], telegram: [], synced: [], pdf: [], tokenCounter: 0, kyc: {}, rawMode: "camel" };
const T = (name) => new Proxy({ __name: name }, { get: (t, k) => (k === "__name" ? name : { t: name, k }) });
const names = { projectsTable: "projects", userProjectsTable: "user_projects", tasksTable: "tasks", usersTable: "users", projectEnrollmentsTable: "project_enrollments", vaultEntriesTable: "vault_entries", projectRatingsTable: "project_ratings", entityProjectRoiTable: "entity_project_roi", projectPnlReceiptsTable: "project_pnl_receipts", financeLedgerEntriesTable: "finance_ledger_entries" };
export const projectsTable = T("projects"), userProjectsTable = T("user_projects"), tasksTable = T("tasks"), usersTable = T("users"), projectEnrollmentsTable = T("project_enrollments"), vaultEntriesTable = T("vault_entries"), projectRatingsTable = T("project_ratings"), entityProjectRoiTable = T("entity_project_roi"), projectPnlReceiptsTable = T("project_pnl_receipts"), financeLedgerEntriesTable = T("finance_ledger_entries");
const val = (x, c) => (x && x.t ? (c[x.t] ? c[x.t][x.k] : null) : x);
export const eq = (a, b) => (c) => val(a, c) === val(b, c);
export const and = (...p) => (c) => p.filter(Boolean).every((f) => (typeof f === "function" ? f(c) : true));
export const ilike = (a, pat) => (c) => String(val(a, c) ?? "").toLowerCase().includes(String(pat).replace(/%/g, "").toLowerCase());
export const isNotNull = () => () => true;
export const count = () => ({ __count: true });
export const sql = Object.assign((s, ...v) => ({ __sql: true, text: s.join("?"), values: v }), { raw: (t) => ({ __raw: t }) });
const clone = (r) => ({ ...r });
const gate = (n) => { if (state.failTable === n) throw new Error("db down"); };
const ev = (p, c) => (p && p.__sql ? (p.text.includes(" IN (") ? ["investment", "expense", "income"].includes(c[Object.keys(c)[0]].kind) : true) : typeof p === "function" ? p(c) : true);
const ts = (d) => d.getTime();
export const db = {
  select(fields) { const q = { joins: [] }; const b = {
    from(t) { q.from = t.__name; return b; }, leftJoin(t, on) { q.joins.push({ n: t.__name, on }); return b; },
    where(p) { if (p && (p.__raw || (p.__sql && !p.text.includes(" IN (")))) state.sqlLog.push(p.__raw ?? p.text); q.pred = p; return b; },
    limit(n) { q.limit = n; return b; }, offset(n) { q.offset = n; return b; }, orderBy(o) { q.order = o; return b; }, groupBy(g) { q.group = g; return b; },
    then(res, rej) { try { gate(q.from); let out = [];
      for (const r of state.rows[q.from]) { const c = { [q.from]: r }; for (const j of q.joins) c[j.n] = state.rows[j.n].find((x) => j.on({ ...c, [j.n]: x })) ?? null; if (ev(q.pred, c)) out.push(c); }
      if (fields && Object.values(fields).some((f) => f && f.__count)) { const k = Object.keys(fields)[0]; return res([{ [k]: out.length }]); }
      if (fields && Object.values(fields).some((f) => f && f.__sql && f.text.includes("SUM(total_roi_distributed)"))) { const k = Object.keys(fields)[0]; return res([{ [k]: out.reduce((s, c) => s + (c[q.from].totalRoiDistributed ?? 0), 0) }]); }
      if (fields && q.group) { const g = new Map(); for (const c of out) { const k = val(q.group, c); g.set(k, (g.get(k) ?? 0) + c[q.from].amount); } return res([...g].map(([kind, total]) => ({ kind, total }))); }
      if (q.order?.__sql && q.order.text.includes("DESC")) { const k = q.order.values[0].k; out.sort((a, b) => ts(b[q.from][k]) - ts(a[q.from][k])); }
      if (q.offset) out = out.slice(q.offset); if (q.limit !== undefined && !Number.isNaN(q.limit)) out = out.slice(0, q.limit);
      res(out.map((c) => fields ? Object.fromEntries(Object.entries(fields).map(([k, ref]) => [k, ref && ref.__name ? (c[ref.__name] ? clone(c[ref.__name]) : null) : val(ref, c)])) : clone(c[q.from]))); } catch (e) { rej(e); } } }; return b; },
  insert: (t) => ({ values: (v) => ({ returning: async (f) => { gate(t.__name); if (t.__name === "project_pnl_receipts" && state.rows[t.__name].some((r) => r.receiptToken === v.receiptToken)) throw new Error("duplicate key receipt_token");
    const row = { id: state.nextId++, createdAt: new Date("2026-01-01T00:00:00Z"), ...(t.__name === "projects" ? { xpPrice: 0.01, status: "active" } : {}), ...(t.__name === "project_enrollments" ? { enrolledAt: new Date("2026-01-02T00:00:00Z"), kycEntryId: null, dataEntityId: null, accountData: null } : {}), ...Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) };
    state.rows[t.__name].push(row); return [f ? Object.fromEntries(Object.keys(f).map((k) => [k, row[k]])) : clone(row)]; }, then: (a, b) => { gate(t.__name); state.rows[t.__name].push({ ...v }); return Promise.resolve().then(a, b); } }) }),
  update: (t) => ({ set: (u) => ({ where: (p) => ({ returning: async () => { gate(t.__name); const hit = state.rows[t.__name].filter((r) => ev(p, { [t.__name]: r })); hit.forEach((r) => Object.assign(r, u)); return hit.map(clone); } }) }) }),
  delete: (t) => ({ where: (p) => { const run = async () => { gate(t.__name); const keep = [], gone = []; for (const r of state.rows[t.__name]) (ev(p, { [t.__name]: r }) ? gone : keep).push(r); state.rows[t.__name] = keep; return gone.map((r) => ({ id: r.id })); }; return { returning: run, then: (a, b) => run().then(a, b) }; } }),
  execute: async (q) => { gate("projects"); const text = q.__raw ?? q.text + JSON.stringify(q.values); state.sqlLog.push(text); return canned(text, q); },
};
const D = (s) => new Date(s);
function canned(text, q) {
  if (text.startsWith("UPDATE projects SET")) { const id = Number(text.match(/WHERE id = (\d+)/)[1]); const r = state.rows.projects.find((x) => x.id === id); if (!r) return { rows: [] }; return { rows: [state.rawMode === "snake" ? { id: r.id, name: r.name, tier: r.tier, created_at: r.createdAt } : { ...clone(r), status: "raw-status" }] }; }
  if (text.includes("SELECT category, duration_type")) return { rows: state.rows.projects.some((r) => r.id === q.values[0]) ? [{ category: "cat", duration_type: "dur", difficulty: "hard", cost_type: "free" }] : [] };
  if (text.includes("p.id as project_id, p.name as project_name, p.project_type, p.category")) return { rows: [
    { project_id: 1, project_name: "Alpha", project_type: null, category: "defi", thumbnail_url: "a.png", total_tasks: 4, completed_tasks: 3, total_profit: "30.5", total_cost: "10", enrollment_id: 1, enrolled_at: D("2026-01-02T00:00:00Z"), enrollment_status: "active" },
    { project_id: 2, project_name: "Beta", project_type: "quest", category: null, thumbnail_url: null, total_tasks: 0, completed_tasks: 0, total_profit: 0, total_cost: 5, enrollment_id: 3, enrolled_at: D("2026-01-03T00:00:00Z"), enrollment_status: "completed" },
    { project_id: 3, project_name: "Gamma", project_type: "x", category: "c", thumbnail_url: null, total_tasks: 2, completed_tasks: 1, total_profit: 1, total_cost: 0, enrollment_id: 9, enrolled_at: D("2026-01-04T00:00:00Z"), enrollment_status: null }] };
  if (text.includes("FROM vault_entries WHERE id =")) { const id = Number(text.match(/WHERE id = (\d+)/)[1]); return { rows: id === 10 ? [{ entity_serial: "E-10", entity_name: "Entity Ten", category: "c", twitter_username: "t", discord_username: "d", email: "e@x" }] : [] }; }
  if (text.includes("DATE(ts.submitted_at)::text")) return { rows: [{ day: "2026-01-01", count: 2 }, { day: D("2026-01-02T00:00:00Z"), count: "3" }] };
  if (text.includes("(SELECT COUNT(DISTINCT pe.project_id)::int")) return { rows: [
    { vault_entry_id: 10, entity_serial: "E-10", entity_name: "Ten", category: "c", total_projects: 2, completed_projects: 1, ongoing_projects: 1, active_projects: 1, disqualified_projects: 0, banned_projects: 0, cancelled_projects: 0, total_completions: 5, total_profit: 10.5, total_cost: 2 },
    { vault_entry_id: 11, entity_serial: null, entity_name: null, category: null, total_projects: 1, completed_projects: 0, ongoing_projects: 1, active_projects: 0, disqualified_projects: 1, banned_projects: 0, cancelled_projects: 0, total_completions: 1, total_profit: 3, total_cost: 3 },
    { vault_entry_id: 12, entity_serial: "E-12", entity_name: "Twelve", category: "c", total_projects: 1, completed_projects: 0, ongoing_projects: 1, active_projects: 0, disqualified_projects: 0, banned_projects: 1, cancelled_projects: 0, total_completions: 0, total_profit: 3, total_cost: 3 }] };
  if (text.includes("COUNT(DISTINCT pe.vault_entry_id)::int AS enrolled_count")) return { rows: [{ id: 1, name: "Alpha", category: "defi", status: "active", enrolled_count: 2 }] };
  if (text.includes("ve.twitter_username, ve.discord_username, ve.telegram_username")) return { rows: [{ id: 10, project_name: "Entity Ten", category: "c", entity_serial: "E-10", status: "active", enrollment_status: "active" }] };
  if (text.includes("COUNT(pe.id)::int as enrolled_count")) return { rows: [{ project_id: "1", project_name: "Alpha", thumbnail_url: null, category: "defi", enrolled_count: "2" }, { project_id: 2, project_name: "Beta", thumbnail_url: "b", category: null, enrolled_count: 1 }] };
  if (text.includes("p.status as project_status, p.thumbnail_url as project_thumbnail_url")) return { rows: [
    { vault_entry_id: 10, entity_serial: "E-10", entity_name: "Ten", category: "c", project_id: 1, project_name: "Alpha", project_status: "active", project_thumbnail_url: "a", enrollment_status: "active", enrolled_at: D("2026-01-02T00:00:00Z") },
    { vault_entry_id: 10, entity_serial: "E-10", entity_name: "Ten", category: "c", project_id: 2, project_name: "Beta", project_status: "completed", project_thumbnail_url: null, enrollment_status: "completed", enrolled_at: D("2026-01-01T00:00:00Z") },
    { vault_entry_id: 11, entity_serial: null, entity_name: null, category: null, project_id: 3, project_name: "Gamma", project_status: null, project_thumbnail_url: null, enrollment_status: "active", enrolled_at: D("2026-01-03T00:00:00Z") }] };
  if (text.includes("up.user_id, up.joined_at, u.username, u.email")) return { rows: [{ user_id: 7, joined_at: D("2026-01-01T00:00:00Z"), username: "alice", email: "a@x", tasks_completed: 2, total_tasks: 4 }, { user_id: 8, joined_at: D("2026-01-02T00:00:00Z"), username: "bob", email: "b@x", tasks_completed: null, total_tasks: 0 }] };
  if (text.includes("FROM tasks WHERE project_id =")) return { rows: [{ id: 1, name: "T1", description: "d", reward_amount: 5, verification_type: "manual", task_type: "social", cost: null, profit: 2 }, { id: 2, name: "T2", description: null, reward_amount: 0, verification_type: "auto", task_type: "onchain", cost: 1, profit: null }] };
  if (text.includes("SELECT pe.*, ve.entity_serial")) return { rows: [{ id: 1, vault_entry_id: 10, entity_serial: "E-10", entity_name: "Ten", category: "c", email: "e", twitter_username: "t", discord_username: "d", status: "active" }, { id: 4, vault_entry_id: 11, entity_serial: null, entity_name: null, category: null, email: null, twitter_username: null, discord_username: null, status: "banned" }] };
  if (text.includes("SELECT status FROM task_submissions")) { const tid = Number(text.match(/task_id = (\d+)/)[1]); return { rows: tid === 1 ? [{ status: "approved" }] : [] }; }
  return { rows: [] };
}
export const requireAuth = (q, s, n) => { const u = q.header("x-user"); if (!u) { s.status(401).json({ error: "auth" }); return; } q.user = { userId: Number(u) }; n(); };
export const requireAdmin = (q, s, n) => requireAuth(q, s, () => (q.header("x-admin") ? n() : s.status(403).json({ error: "admin" })));
export const requireRoles = (...roles) => (q, s, n) => requireAuth(q, s, () => (roles.includes(q.header("x-role") ?? "") ? n() : s.status(403).json({ error: "role" })));
export const pepDecisionObserver = () => {};
export const requireCreditBalance = (action) => (q, s, n) => (q.header("x-nocredit") ? s.status(402).json({ error: "insufficient credits", action }) : n());
export const chargeCredits = async (userId, action) => { state.charges.push([userId, action]); return { ok: !state.noCharge, charged: 1, newBalance: 9 }; };
export const requireOwnership = (action, builder, opts) => async (q, s, n) => { const r = await builder(q); state.pep.push([action, r.type, String(r.id), r.ownerId]); if (r.ownerId === q.user.userId) n(); else opts.onDeny(q, s); };
export const requirePublicAudit = (action) => (q, s, n) => { state.pep.push([action, "public"]); n(); };
export const authorize = async ({ action, resource }) => { state.audits.push([action, resource.type, String(resource.id), resource.ownerId]); };
export class PolicyEngine { constructor() {} registerRule() {} }
export const createResourceOwnershipRule = () => ({});
export const logSubjectActivity = (type, id, action, opts) => { state.activity.push([type, id, action, JSON.stringify(opts)]); };
export const getSubjectActivitySummary = async (type, id) => { gate("activity"); return { subject: type, id, totals: { daysActive: 3 } }; };
export const getUserEnrollmentsOverview = async (u) => { gate("activity"); return { kind: "mine", u }; };
export const getUserEntitiesOverview = async (u) => { gate("activity"); return { kind: "entities", u }; };
export const getProjectEnrollmentsOverview = async (u, p) => { gate("activity"); return { kind: "project", u, p }; };
export const kycEntryOwnerResource = async (id) => ({ type: "kyc_entry", id, ownerId: 7 });
export const loadKycEntryForEnrollment = async (userId, id) => { const r = state.kyc[id]; return r && r.userId === userId ? r : null; };
export const buildEnrollmentAccountData = (row) => ({ built: true, from: row.id });
export const streamFantasticReceiptPdf = (res, spec) => { state.pdf.push(spec); res.json({ pdf: spec }); };
export const broadcastEvent = (e, d) => state.events.push([e, d]);
export const syncOnProjectDelete = (id) => { state.synced.push(id); return Promise.resolve(); };
export const notifyNewProject = (p) => { state.telegram.push(p); return Promise.resolve(); };
export const getUserFromToken = async (t) => (t === "7" ? { userId: 7 } : null);
export const randomBytes = (n) => Buffer.from(`T${++state.tokenCounter}`.padEnd(n, "x"));
export default { randomBytes };
export const hasCreditBalance = async () => ({ ok: true });
