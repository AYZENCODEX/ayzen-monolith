export const state = { rows: {}, nextId: 500, events: [], sqlLog: [], telegram: [], synced: [], failTable: null, rawMode: "camel" };
const T = (name) => new Proxy({ __name: name }, { get: (t, k) => (k === "__name" ? name : { t: name, k }) });
export const projectsTable = T("projects"), tasksTable = T("tasks"), userProjectsTable = T("user_projects"), projectEnrollmentsTable = T("project_enrollments");
const val = (x, c) => (x && x.t ? (c[x.t] ? c[x.t][x.k] : null) : x);
export const eq = (a, b) => (c) => val(a, c) === val(b, c);
export const and = (...p) => (c) => p.filter(Boolean).every((f) => typeof f === "function" ? f(c) : true);
export const ilike = (a, pat) => (c) => String(val(a, c) ?? "").toLowerCase().includes(String(pat).replace(/%/g, "").toLowerCase());
export const count = () => ({ __count: true });
export const sql = Object.assign((s, ...v) => ({ __sql: true, text: s.join("?"), values: v }), { raw: (t) => ({ __raw: t }) });
const clone = (r) => ({ ...r });
const gate = (n) => { if (state.failTable === n) throw new Error("db down"); };
const ev = (p, c) => (typeof p === "function" ? p(c) : true);
const db = {
  select(fields) { const q = {}; const b = { from(t) { q.from = t.__name; return b; }, where(p) { if (p && (p.__raw || p.__sql)) state.sqlLog.push(p.__raw ?? p.text); q.pred = p; return b; }, limit(n) { q.limit = n; return b; }, offset(n) { q.offset = n; return b; },
    then(res, rej) { try { gate(q.from); let rows = state.rows[q.from].filter((r) => ev(q.pred, { [q.from]: r }));
      if (fields && Object.values(fields).some((f) => f && f.__count)) { const k = Object.keys(fields)[0]; return res([{ [k]: rows.length }]); }
      if (q.offset) rows = rows.slice(q.offset); if (q.limit !== undefined && !Number.isNaN(q.limit)) rows = rows.slice(0, q.limit); res(rows.map(clone)); } catch (e) { rej(e); } } }; return b; },
  insert: (t) => ({ values: (v) => ({ returning: async () => { gate(t.__name); const row = { id: state.nextId++, createdAt: new Date("2026-01-01T00:00:00Z"), xpPrice: 0.01, status: "active", ...Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) }; state.rows[t.__name].push(row); return [clone(row)]; } }) }),
  update: (t) => ({ set: (u) => ({ where: (p) => ({ returning: async () => { gate(t.__name); const hit = state.rows[t.__name].filter((r) => ev(p, { [t.__name]: r })); hit.forEach((r) => Object.assign(r, u)); return hit.map(clone); } }) }) }),
  delete: (t) => ({ where: async (p) => { gate(t.__name); state.rows[t.__name] = state.rows[t.__name].filter((r) => !ev(p, { [t.__name]: r })); } }),
  execute: async (q) => { gate("projects"); const text = q.__raw ?? q.text + JSON.stringify(q.values); state.sqlLog.push(text);
    if (text.startsWith("UPDATE projects SET")) { const id = Number(text.match(/WHERE id = (\d+)/)[1]); const r = state.rows.projects.find((x) => x.id === id); if (!r) return { rows: [] }; return { rows: [state.rawMode === "snake" ? { id: r.id, name: r.name, tier: r.tier, created_at: r.createdAt } : { ...clone(r), status: "raw-status" }] }; }
    if (text.includes("SELECT category")) { const id = q.values[0]; return { rows: state.rows.projects.some((r) => r.id === id) ? [{ category: "cat", duration_type: "dur", difficulty: "hard", cost_type: "free" }] : [] }; }
    return { rows: [] }; },
};
export { db };
export const requireAuth = (q, s, n) => { q.header("x-user") ? ((q.user = { userId: Number(q.header("x-user")) }), n()) : s.status(401).json({ error: "auth" }); };
export const requireAdmin = (q, s, n) => (q.header("x-admin") ? n() : s.status(403).json({ error: "admin" }));
export const requireRoles = (...roles) => (q, s, n) => (roles.includes(q.header("x-role") ?? "") ? n() : s.status(403).json({ error: "role" }));
export const broadcastEvent = (e, d) => state.events.push([e, d]);
export const getUserFromToken = async (t) => (t === "7" ? { userId: 7 } : null);
export const notifyNewProject = (p) => { state.telegram.push(p); return Promise.resolve(); };
export const syncOnProjectDelete = (id) => { state.synced.push(id); return Promise.resolve(); };
