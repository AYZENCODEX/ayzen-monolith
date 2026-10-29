export const state = { rows: {}, nextId: 1000, events: [], failTable: null };
const T = (name) => new Proxy({ __name: name }, { get: (t, k) => (k === "__name" ? name : { t: name, k }) });
export const projectRatingsTable = T("project_ratings");
export const projectsTable = T("projects");
export const usersTable = T("users");
export const projectTemplatesTable = T("templates");
export const PROJECT_TEMPLATE_DATA_KEYS = ["category","subcategory","projectType","exchangeSubType","accountCategory","tier","experienceLevel","durationType","difficulty","costType","xpName","xpPrice","tutorialLink","tutorialSteps","badges"];
const val = (x, c) => (x && x.t ? (c[x.t] ? c[x.t][x.k] : null) : x);
export const eq = (a, b) => (c) => val(a, c) === val(b, c);
export const ne = (a, b) => (c) => val(a, c) !== val(b, c);
export const and = (...p) => (c) => p.filter(Boolean).every((f) => f(c));
export const desc = (col) => ({ desc: col });
export const sql = (strings, ...values) => ({ __sql: true, text: strings.join("?"), values });
const clone = (r) => ({ ...r });
const gate = (name) => { if (state.failTable === name) throw new Error("db down"); };
const evalPred = (p, c) => (p && p.__sql ? (p.text.includes("lower(") ? String(val(p.values[0], c)).toLowerCase() === String(p.values[1]).toLowerCase() : true) : !p || p(c));
function makeDb(rows) {
  const sel = (fields) => { const q = {}; const b = {
    from(t) { q.from = t.__name; return b; }, leftJoin(t, on) { q.join = { n: t.__name, on }; return b; },
    where(p) { q.pred = p; return b; }, orderBy(o) { q.order = o; return b; },
    then(res, rej) { try { gate(q.from); let out = [];
      for (const r of rows[q.from]) { const c = { [q.from]: r }; if (q.join) c[q.join.n] = rows[q.join.n].find((j) => q.join.on({ ...c, [q.join.n]: j })) ?? null; if (evalPred(q.pred, c)) out.push(c); }
      if (q.order?.__sql && q.order.text.includes("DESC")) { const k = q.order.values[0].k; out.sort((a, b) => b[q.from][k] - a[q.from][k]); }
      if (q.order?.desc) { const k = q.order.desc.k; out.sort((a, b) => b[q.from][k] - a[q.from][k]); }
      res(out.map((c) => fields ? Object.fromEntries(Object.entries(fields).map(([k, ref]) => [k, ref && ref.__name ? clone(c[ref.__name]) : val(ref, c)])) : clone(c[q.from]))); } catch (e) { rej(e); } } }; return b; };
  const uniqueName = (t, name, exceptId) => { if (t === "templates" && rows.templates.some((r) => r.id !== exceptId && r.name.toLowerCase() === String(name).toLowerCase())) throw new Error('duplicate key value violates unique constraint "ayzen_project_templates_name_key"'); };
  return {
    select: sel,
    insert: (t) => ({ values: (v) => ({ returning: async () => { gate(t.__name); uniqueName(t.__name, v.name); const now = new Date("2026-01-01T00:00:00Z"); const row = { id: state.nextId++, createdAt: now, updatedAt: now, usageCount: 0, defaultForProjectType: null, ...v }; if (t.__name === "templates" && v.defaultForProjectType === undefined) row.defaultForProjectType = null; rows[t.__name].push(row); return [clone(row)]; } }) }),
    update: (t) => ({ set: (u) => ({ where: (p) => { const run = async () => { gate(t.__name); if (!Object.keys(u).length) throw new Error("No values to set"); const hit = rows[t.__name].filter((r) => evalPred(p, { [t.__name]: r })); for (const r of hit) { const nu = {}; for (const [k, v] of Object.entries(u)) nu[k] = v && v.__sql ? r[k] + 1 : v; if (nu.name) uniqueName(t.__name, nu.name, r.id); Object.assign(r, nu); } return hit.map(clone); }; const pr = { returning: run, then: (a, b) => run().then(a, b) }; return pr; } }) }),
    delete: (t) => ({ where: (p) => { const run = async () => { gate(t.__name); const keep = [], gone = []; for (const r of rows[t.__name]) (evalPred(p, { [t.__name]: r }) ? gone : keep).push(r); rows[t.__name].splice(0, rows[t.__name].length, ...keep); return gone.map(clone); }; return { returning: run, then: (a, b) => run().then(a, b) }; } }),
    execute: async (q) => { gate("projects"); const id = q.values[0]; return { rows: rows.projects.filter((r) => r.id === id).map(clone) }; },
    transaction: async (fn) => { const snap = JSON.stringify(rows); try { return await fn(makeDb(rows)); } catch (e) { const back = JSON.parse(snap, (k, v) => (typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) ? new Date(v) : v)); for (const k of Object.keys(rows)) rows[k].splice(0, rows[k].length, ...back[k]); throw e; } },
  };
}
export const db = makeDb((state.rows = { project_ratings: [], projects: [], users: [], templates: [] }));
export const requireAuth = (q, s, n) => { const u = q.header("x-user"); if (!u) { s.status(401).json({ error: "auth" }); return; } q.user = { userId: Number(u) }; n(); };
export const requireAdmin = (q, s, n) => requireAuth(q, s, () => (q.header("x-admin") ? n() : s.status(403).json({ error: "admin" })));
export const requireRoles = (...roles) => requireAuth_roles(roles);
const requireAuth_roles = (roles) => (q, s, n) => requireAuth(q, s, () => (roles.includes(q.header("x-role") ?? "") ? n() : s.status(403).json({ error: "role" })));
export const getRequestUserId = (q) => q.user?.userId ?? null;
export const broadcastEvent = (e, d) => state.events.push([e, d]);
