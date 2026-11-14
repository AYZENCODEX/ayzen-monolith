#!/usr/bin/env node
/**
 * scripts/check-module-isolation.mjs — W2-P1 CI check (blocking): from any module host, another module's path is a 404.
 * Install-free. Two halves:
 *   1. BEHAVIOR: the real decision function (packages/module-registry/src/index.mjs) over the full module x prefix matrix and
 *      a list of path tricks (case, //, dot-segments, percent-encoding, allow-list laundering).
 *   2. WIRING: the middleware really sits in front of the router / pages / CORS / headers, defaults to off, and denies with
 *      the unknown-endpoint 404.
 * Also prints an informational coverage report: how much of the API surface the registry assigns to a module.
 *   node scripts/check-module-isolation.mjs              # check
 *   node scripts/check-module-isolation.mjs --self-test  # prove each rule fails on a deliberate breakage
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "artifacts/api-server/src";
const REG = "packages/module-registry/src/index.mjs";
const FILES = [REG, `${API}/app.ts`, `${API}/middlewares/security.ts`, `${API}/lib/module-host-guard.ts`, `${API}/lib/module-host-guard-core.ts`, "docs/identity-boundaries.md", ".github/workflows/ci.yml"];
const load = () => Object.fromEntries(FILES.map((f) => [f, readFileSync(join(ROOT, f), "utf8")]));

async function importSource(src) {
  const dir = mkdtempSync(join(tmpdir(), "isolation-"));
  const file = join(dir, "registry.mjs");
  writeFileSync(file, src);
  try { return await import(pathToFileURL(file).href + `?v=${Math.random()}`); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const order = (text, needles) => { let at = -1; for (const n of needles) { const i = text.indexOf(n, at + 1); if (i < 0) return `missing '${n}'`; at = i; } return null; };

/** BEHAVIOR rules take the imported registry module. */
const BEHAVIOR = [
  ["every module host: other modules' prefixes are denied (404), own prefixes and plumbing are allowed", (r) => {
    for (const m of r.MODULES) for (const o of r.MODULES) for (const p of o.routePrefixes) {
      const d = r.decideModuleHostAccess({ module: m.id, path: `${p}/x` });
      if (o.id === m.id ? d.action !== "allow" : d.action !== "deny") return `${m.id} on ${p}: ${d.action}`;
    }
    for (const m of r.MODULES) for (const a of r.MODULE_HOST_ALLOWED_PREFIXES) {
      for (const strict of [false, true]) if (r.decideModuleHostAccess({ module: m.id, path: `${a}/x`, strict }).action !== "allow") return `${m.id} must reach ${a} (strict=${strict})`;
    }
    return null;
  }],
  ["path tricks never reach another module", (r) => {
    const target = r.MODULES.find((m) => m.id === "fyra").routePrefixes[0];
    const tricks = [target.toUpperCase(), "/" + target, "/./" + target.slice(1), "/vault/../" + target.slice(1), "/auth/../" + target.slice(1), "/health/.." + target,
      "/%66inance", "/%46INANCE/x", target + "?next=/vault", "/oidc/%2e%2e" + target];
    for (const t of tricks) for (const strict of [false, true]) if (r.decideModuleHostAccess({ module: "sylo", path: t, strict }).action !== "deny") return `sylo reached ${t} (strict=${strict})`;
    for (const bad of ["/%zz", "/a%00b", "/a\\b"]) if (r.decideModuleHostAccess({ module: "sylo", path: bad }).action !== "deny") return `malformed ${bad} allowed`;
    return null;
  }],
  ["allow-list is a path boundary, not a substring; strict denies unowned paths unless shared-listed", (r) => {
    if (r.decideModuleHostAccess({ module: "sylo", path: "/authx", strict: true }).action !== "deny") return "/authx allowed";
    if (r.decideModuleHostAccess({ module: "sylo", path: "/users", strict: true }).action !== "deny") return "strict allowed an unowned path";
    if (r.decideModuleHostAccess({ module: "sylo", path: "/users", strict: true, sharedPrefixes: ["/users"] }).action !== "allow") return "shared prefix ignored";
    return r.decideModuleHostAccess({ module: "sylo", path: "/users" }).action === "allow" ? null : "owned mode must leave unowned paths alone";
  }],
  ["registry: no prefix owned twice, none collides with the allow-list, unknown module denied", (r) => {
    const seen = new Map();
    for (const m of r.MODULES) for (const p of m.routePrefixes) {
      if (seen.has(p)) return `${p} owned by ${seen.get(p)} and ${m.id}`;
      seen.set(p, m.id);
      if (r.MODULE_HOST_ALLOWED_PREFIXES.some((a) => p === a || p.startsWith(a + "/"))) return `${p} collides with the allow-list`;
    }
    return r.decideModuleHostAccess({ module: "nope", path: "/auth" }).action === "deny" ? null : "unknown module allowed";
  }],
];

/** WIRING rules take the file map. */
const WIRING = [
  ["app.ts: API guard sits after the limiter and BEFORE the role-host gate and the router", (f) => order(f[`${API}/app.ts`], ['app.use("/api", globalLimiter, moduleHostApiGuard, roleHostApiGate, apiKeyScopeGate, router)'])],
  ["app.ts: page guard runs before the role-host page gate and before the SPA is served; headers follow the security headers", (f) => {
    const a = f[`${API}/app.ts`];
    return order(a, ["app.use(securityHeaders)", "app.use(moduleHostHeaders)"]) || order(a, ["app.use(moduleHostPageGuard)", "app.use(roleHostPageGate)", "app.use(express.static(distPath))"]);
  }],
  ["guard: module comes from the request context (Origin-first) or the Host, never from body/query/headers", (f) => {
    const g = f[`${API}/lib/module-host-guard.ts`].replace(/\/\*[\s\S]*?\*\//g, "");
    if (!g.includes('apply("api", currentModuleContext()') || !g.includes('apply("page", resolveRequestModule(req.hostname)')) return "guard module source changed";
    return /req\.(body|query)|headers\[|req\.get\(|req\.header\(/.test(g) ? "guard must not read module from request fields" : null;
  }],
  ["guard: denial is the unknown-endpoint 404 (notFoundHandler), report mode never refuses", (f) => {
    const g = f[`${API}/lib/module-host-guard.ts`], c = f[`${API}/lib/module-host-guard-core.ts`];
    return g.includes("if (r.refuse) { notFoundHandler(req, res); return; }") && c.includes('refuse: wouldDeny && mode !== "report"') ? null : "denial/report semantics changed";
  }],
  ["core: default mode is off; no module => never refused; strict flag comes from the mode; uses the registry decision", (f) => {
    const c = f[`${API}/lib/module-host-guard-core.ts`];
    const ok = c.includes(': "off";') && c.includes('if (mode === "off" || !module) return') && c.includes('strict: mode === "strict"') && c.includes("decideModuleHostAccess({ module");
    return ok ? null : "mode defaults / strict mapping changed";
  }],
  ["CORS: a production first-party origin must be a registered host when the guard enforces (ALLOWED_ORIGINS still wins)", (f) => {
    const s = f[`${API}/middlewares/security.ts`];
    return s.includes("isModuleHostGuardEnforcing() && !isRegisteredFirstPartyOrigin(origin) && !(allowedOrigins?.includes(origin))") ? null : "CORS registered-host check missing";
  }],
  ["headers: CSP frame-ancestors + Referrer-Policy only on module hosts and only when enforcing", (f) => {
    const g = f[`${API}/lib/module-host-guard.ts`];
    return g.includes("isModuleHostGuardEnforcing() && resolveRequestModule(req.hostname)") && g.includes("frame-ancestors ${moduleFrameAncestors()}") && g.includes('"Referrer-Policy", "no-referrer"') ? null : "module host headers changed";
  }],
  ["docs + CI: isolation check is documented and runs in CI", (f) => {
    const c = f[".github/workflows/ci.yml"];
    const runs = (c.match(/check-module-isolation\.mjs/g) ?? []).length >= 2 && c.includes("check-module-isolation.mjs --self-test") && c.includes("test:module-host-guard");
    return runs && f["docs/identity-boundaries.md"].includes("MODULE_HOST_GUARD_MODE") ? null : "CI wiring or docs missing";
  }],
];

async function run(files) {
  const problems = [];
  let reg;
  try { reg = await importSource(files[REG]); } catch (e) { return [`registry does not load: ${e.message}`]; }
  for (const [id, fn] of BEHAVIOR) { let p; try { p = fn(reg); } catch (e) { p = `threw: ${e.message}`; } if (p) problems.push(`${id}: ${p}`); }
  for (const [id, fn] of WIRING) { let p; try { p = fn(files); } catch (e) { p = `threw: ${e.message}`; } if (p) problems.push(`${id}: ${p}`); }
  return problems;
}

async function coverage(reg) {
  const t = readFileSync(join(ROOT, "packages/endpoint-registry/src/index.mjs"), "utf8");
  const paths = [...t.matchAll(/^\s*\["[a-z_-]+", "[A-Z]+", "(\/api\/[^"]*)"/gm)].map((m) => m[1].replace(/^\/api/, ""));
  const by = {}; const unowned = {};
  for (const p of paths) { const o = reg.getModuleIdForPath(p) ?? "unowned"; by[o] = (by[o] ?? 0) + 1; if (o === "unowned") { const k = "/" + p.split("/")[1]; unowned[k] = (unowned[k] ?? 0) + 1; } }
  const top = Object.entries(unowned).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}:${v}`).join(" ");
  return { endpoints: paths.length, byOwner: by, topUnowned: top };
}

if (process.argv.includes("--self-test")) {
  const base = load();
  const clean = await run(base);
  if (clean.length) { console.error("self-test needs a clean tree first:\n - " + clean.join("\n - ")); process.exit(1); }
  const A = `${API}/app.ts`, G = `${API}/lib/module-host-guard.ts`, C = `${API}/lib/module-host-guard-core.ts`, S = `${API}/middlewares/security.ts`;
  const mutants = [
    ["decision ignores other modules", REG, 'if (owner && owner !== module) return { action: "deny", reason: "other_module", owner };', ""],
    ["decision stops lower-casing", REG, "decoded.toLowerCase().split", "decoded.split"],
    ["decision stops decoding", REG, "decoded = decodeURIComponent(noQuery);", "decoded = noQuery;"],
    ["decision stops resolving dot segments", REG, 'if (seg === "..") { out.pop(); continue; }', 'if (seg === "..") { continue; }'],
    ["decision judges only the normalized spelling", REG, "for (const c of candidates) {\n    const owner", "for (const c of candidates.slice(1)) {\n    const owner"],
    ["allow-list becomes a substring match", REG, "[...MODULE_HOST_ALLOWED_PREFIXES, ...sharedPrefixes].some((p) => hasPrefix(c, p))", "[...MODULE_HOST_ALLOWED_PREFIXES, ...sharedPrefixes].some((p) => c.includes(p))"],
    ["strict stops denying unowned paths", REG, "if (strict && !candidates.every(covered))", "if (false && !candidates.every(covered))"],
    ["malformed paths allowed", REG, 'if (!candidates) return { action: "deny", reason: "malformed_path", owner: null };', "if (!candidates) return { action: \"allow\", reason: \"unowned\", owner: null };"],
    ["unknown module allowed", REG, 'if (!own) return { action: "deny", reason: "unknown_module", owner: null };', ""],
    ["API guard not mounted", A, "moduleHostApiGuard, roleHostApiGate", "roleHostApiGate"],
    ["API guard mounted after the role gate", A, "moduleHostApiGuard, roleHostApiGate, apiKeyScopeGate", "roleHostApiGate, moduleHostApiGuard, apiKeyScopeGate"],
    ["page guard removed", A, "app.use(moduleHostPageGuard);\n", ""],
    ["headers removed", A, "app.use(moduleHostHeaders);\n", ""],
    ["guard trusts a request field", G, "apply(\"api\", currentModuleContext(),", "apply(\"api\", (req.query.module as any) ?? currentModuleContext(),"],
    ["denial leaks a distinct body", G, "if (r.refuse) { notFoundHandler(req, res); return; }", "if (r.refuse) { res.status(403).json({ error: 'wrong module' }); return; }"],
    ["report mode refuses", C, 'refuse: wouldDeny && mode !== "report"', "refuse: wouldDeny"],
    ["default mode becomes owned", C, ': "off";', ': "owned";'],
    ["no module context is refused", C, 'if (mode === "off" || !module) return', 'if (mode === "off") return'],
    ["strict flag lost", C, 'strict: mode === "strict"', "strict: false"],
    ["CORS check removed", S, "isModuleHostGuardEnforcing() && !isRegisteredFirstPartyOrigin(origin)", "false && !isRegisteredFirstPartyOrigin(origin)"],
    ["headers on every host", G, "isModuleHostGuardEnforcing() && resolveRequestModule(req.hostname)", "isModuleHostGuardEnforcing()"],
    ["frame-ancestors dropped", G, "frame-ancestors ${moduleFrameAncestors()}", "default-src ${moduleFrameAncestors()}"],
    ["CI forgets the check", ".github/workflows/ci.yml", "check-module-isolation.mjs --self-test", "check-module-isolation-x.mjs --self-test"],
  ];
  let survived = 0;
  for (const [name, file, from, to] of mutants) {
    if (!base[file].includes(from)) { console.error(`MUTANT NOT APPLICABLE (fix the self-test): ${name}`); survived++; continue; }
    if ((await run({ ...base, [file]: base[file].replace(from, to) })).length === 0) { console.error(`SURVIVED: ${name}`); survived++; }
  }
  console.log(survived ? `SELF-TEST FAILED: ${survived} mutant(s) not caught` : `SELF-TEST OK: ${mutants.length}/${mutants.length} mutants caught`);
  process.exit(survived ? 1 : 0);
}

const files = load();
const problems = await run(files);
const cov = await coverage(await importSource(files[REG]));
if (problems.length) { console.error("MODULE_ISOLATION: FAIL\n - " + problems.join("\n - ")); process.exit(1); }
console.log("MODULE_ISOLATION: PASS");
console.log(JSON.stringify({ rules: BEHAVIOR.length + WIRING.length, ...cov }));
