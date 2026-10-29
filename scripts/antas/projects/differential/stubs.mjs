// Shared stubs for @workspace/db, drizzle-orm, auth middleware and log-bus.
export const state = { rows: { project_dates: [], projects: [], project_enrollments: [] }, nextId: 100, fail: false, logs: [] };
const table = (name) => new Proxy({ __name: name }, { get: (t, k) => (k === "__name" ? name : k === "$inferSelect" ? undefined : { t: name, k }) });
export const projectDatesTable = table("project_dates");
export const projectsTable = table("projects");
export const projectEnrollmentsTable = table("project_enrollments");
export const eq = (a, b) => (ctx) => val(a, ctx) === val(b, ctx);
export const gte = (a, b) => (ctx) => val(a, ctx) >= val(b, ctx);
export const lte = (a, b) => (ctx) => val(a, ctx) <= val(b, ctx);
export const isNull = (a) => (ctx) => val(a, ctx) == null;
export const inArray = (a, xs) => (ctx) => xs.includes(val(a, ctx));
export const and = (...ps) => (ctx) => ps.filter(Boolean).every((p) => p(ctx));
function val(x, ctx) { return x && x.t ? (ctx[x.t] ? ctx[x.t][x.k] : null) : x; }
const clone = (r) => ({ ...r });
function guard() { if (state.fail) throw new Error("db down"); }
function selectBuilder(fields) {
  const q = { from: null, join: null, pred: null };
  const b = {
    from(t) { q.from = t.__name; return b; },
    leftJoin(t, on) { q.join = { name: t.__name, on }; return b; },
    where(p) { q.pred = p; return b; },
    then(res, rej) {
      try {
        guard();
        let out = [];
        for (const r of state.rows[q.from]) {
          const ctx = { [q.from]: r };
          if (q.join) ctx[q.join.name] = state.rows[q.join.name].find((j) => q.join.on({ ...ctx, [q.join.name]: j })) ?? null;
          if (!q.pred || q.pred(ctx)) out.push(ctx);
        }
        out = out.map((ctx) => fields ? Object.fromEntries(Object.entries(fields).map(([k, ref]) => [k, val(ref, ctx)])) : clone(ctx[q.from]));
        res(out);
      } catch (e) { rej(e); }
    },
  };
  return b;
}
export const db = {
  select: (fields) => selectBuilder(fields),
  insert: (t) => ({ values: (v) => ({ returning: async () => { guard(); const row = { id: state.nextId++, remindedAt: null, createdAt: new Date("2026-01-01T00:00:00Z"), ...v }; state.rows[t.__name].push(row); return [clone(row)]; } }) }),
  update: (t) => ({ set: (u) => ({ where: (p) => ({ returning: async () => { guard(); if (!Object.keys(u).length) throw new Error("No values to set"); const hit = state.rows[t.__name].filter((r) => p({ [t.__name]: r })); hit.forEach((r) => Object.assign(r, u)); return hit.map(clone); } }) }) }),
  delete: (t) => ({ where: (p) => ({ returning: async () => { guard(); const keep = [], gone = []; for (const r of state.rows[t.__name]) (p({ [t.__name]: r }) ? gone : keep).push(r); state.rows[t.__name] = keep; return gone.map(clone); } }) }),
};
export const requireAuth = (req, res, next) => { const u = req.header("x-user"); if (!u) { res.status(401).json({ error: "auth" }); return; } req.user = { userId: Number(u) }; next(); };
export const requireAdmin = (req, res, next) => { requireAuth(req, res, () => { if (!req.header("x-admin")) { res.status(403).json({ error: "admin" }); return; } next(); }); };
export const logBus = { system: (m) => state.logs.push(m) };
