// Write half of extract-infra.mjs (see that file). Applies the computed edits and generates / extends the infrastructure files.
import fs from "node:fs";
const { cfg, repoWork, ts, abs, rel, resolveSpec } = globalThis.__extract;
const importLine = (loc, ii, fromRepo) => {
  const spec = ii.spec.startsWith("artifacts/") ? rel(fromRepo, ii.spec) : ii.spec;
  if (ii.kind === "named") return `import ${ii.typeOnly ? "type " : ""}{ ${ii.imported === loc ? loc : `${ii.imported} as ${loc}`} } from "${spec}";`;
  if (ii.kind === "ns") return `import * as ${loc} from "${spec}";`;
  return `import ${ii.typeOnly ? "type " : ""}${loc} from "${spec}";`;
};
const lastImportEnd = (text) => { const sf = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true); let e = 0; for (const s of sf.statements) if (ts.isImportDeclaration(s)) e = s.getEnd(); return e; };
const importedLocals = (text) => { const sf = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true); const s = new Set(); for (const st of sf.statements) if (ts.isImportDeclaration(st) && st.importClause) { const c = st.importClause; if (c.name) s.add(c.name.text); if (c.namedBindings) { if (ts.isNamespaceImport(c.namedBindings)) s.add(c.namedBindings.name.text); else for (const e of c.namedBindings.elements) s.add(e.name.text); } } return s; };

// shared infrastructure files
import path from "node:path";
for (const f of [cfg.dbHandleFile, cfg.cronFile, cfg.portsFile, ...[...repoWork.keys()]]) fs.mkdirSync(path.dirname(abs(f)), { recursive: true });
const DB_HANDLE = cfg.dbHandleFile, CRON = cfg.cronFile, PORTS = cfg.portsFile;
const need = { tx: false, cron: false, ports: new Map() };
for (const item of cfg.files) for (const e of item.edits ?? []) { if (e.kind === "tx") need.tx = true; if (e.kind === "cron") need.cron = true; if (e.kind === "port") need.ports.set(e.alias, { orig: e.orig, spec: e.spec, file: item.file }); }
const needsExecutor = [...repoWork.values()].some((r) => r.needsExecutor);
const needBare = cfg.files.some((i) => (i.edits ?? []).some((e) => e.kind === "bare"));
if (need.tx || needsExecutor || needBare) fs.writeFileSync(abs(DB_HANDLE), [
  'import { db } from "@workspace/db";',
  "",
  "/** A drizzle transaction handle (the `tx` passed to `db.transaction(async (tx) => ...)`). */",
  "export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];",
  "/** Anything a repository function may run a query on: the shared pool or an open transaction. */",
  "export type DbExecutor = typeof db | DbTx;",
  "",
  "/** The shared pool, for code that must choose between it and an override handle (VLT-GAP-12). */",
  "export const defaultDb: typeof db = db;",
  "",
  "/** `db.transaction` — the only way Vault application code opens a transaction (VLT-GAP-12). */",
  "export const runInTransaction = ((...args: Parameters<typeof db.transaction>) => db.transaction(...args)) as typeof db.transaction;",
  "",
].join("\n"));
if (need.cron) fs.writeFileSync(abs(CRON), `import cron from "node-cron";

/** \`cron.validate\` / \`cron.schedule\` — the only way Vault application code touches the scheduler (VLT-GAP-12). */
export const validateCronExpression = ((...args: Parameters<typeof cron.validate>) => cron.validate(...args)) as typeof cron.validate;
export const scheduleCronJob = ((...args: Parameters<typeof cron.schedule>) => cron.schedule(...args)) as typeof cron.schedule;
`);
if (need.ports.size) {
  const byMod = new Map();
  for (const [alias, v] of need.ports) { const k = v.spec; if (!byMod.has(k)) byMod.set(k, []); byMod.get(k).push(`${v.orig} as ${alias}`); }
  fs.writeFileSync(abs(PORTS), `/**\n * Provider / event ports (VLT-GAP-12): Vault application code reaches email, notifications, Telegram and the domain-event bus only\n * through these aliases, so the layer rule (application -> infrastructure) holds for providers as it does for persistence.\n */\n` + [...byMod].map(([spec, names]) => `export { ${names.join(", ")} } from "${rel(PORTS, spec)}";`).join("\n") + "\n");
}

// lazily loaded provider ports (dynamic imports keep their laziness; only the module they load changes)
{ const lazy = new Map(); for (const item of cfg.files) for (const e of item.edits ?? []) if (e.kind === "dynamic") { const k = e.dp.to; if (!lazy.has(k)) lazy.set(k, { from: e.dp.from, names: new Set() }); e.names.forEach((n) => lazy.get(k).names.add(n)); }
  for (const [to, v] of lazy) { fs.mkdirSync(path.dirname(abs(to)), { recursive: true }); fs.writeFileSync(abs(to), `/** Lazily loaded provider port (VLT-GAP-12): application code \`import()\`s this instead of the provider module. */\nexport { ${[...v.names].join(", ")} } from "${rel(to, v.from)}";\n`); } }

// repositories
for (const [repo, w] of repoWork) {
  const grouped = new Map();
  for (const [loc, ii] of w.imports) { const spec = ii.spec.startsWith("artifacts/") ? rel(repo, ii.spec) : ii.spec; const key = `${spec}|${ii.kind}|${ii.typeOnly ? "t" : "v"}`; if (!grouped.has(key)) grouped.set(key, { spec, kind: ii.kind, typeOnly: ii.typeOnly, items: [] }); grouped.get(key).items.push([loc, ii]); }
  const have = w.existing ? importedLocals(w.existing) : new Set();
  const mk = (g) => { const items = g.items.filter(([loc]) => !have.has(loc)); if (!items.length) return null; return g.kind === "named" ? `import ${g.typeOnly ? "type " : ""}{ ${items.map(([loc, ii]) => (ii.imported === loc ? loc : `${ii.imported} as ${loc}`)).sort().join(", ")} } from "${g.spec}";` : importLine(items[0][0], items[0][1], repo); };
  const lines = [...grouped.values()].map(mk).filter(Boolean);
  if (w.needsExecutor && !(w.existing && /\bDbExecutor\b/.test(w.existing))) lines.push(`import type { DbExecutor } from "${rel(repo, DB_HANDLE)}";`);
  if (w.existing) {
    const add = lines;
    const at = lastImportEnd(w.existing);
    fs.writeFileSync(abs(repo), w.existing.slice(0, at) + (add.length ? "\n" + add.join("\n") : "") + w.existing.slice(at).replace(/\n*$/, "\n") + "\n" + w.fns.join("\n\n") + "\n");
  } else {
    fs.writeFileSync(abs(repo), `${cfg.header(repo)}${lines.join("\n")}\n\n${w.fns.join("\n\n")}\n`);
  }
}

// application files
const identUsed = (text, name, skipImports, valueOnly) => { const sf = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true); let n = 0; const v = (x) => { if (ts.isImportDeclaration(x)) return; if (ts.isIdentifier(x) && x.text === name && !(valueOnly && (() => { for (let p = x.parent; p; p = p.parent) { if (ts.isTypeQueryNode(p)) return true; if (ts.isTypeNode(p) && !ts.isExpressionWithTypeArguments(p)) return true; } return false; })()) && !(ts.isPropertyAccessExpression(x.parent) && x.parent.name === x) && !(ts.isPropertyAssignment(x.parent) && x.parent.name === x)) n++; ts.forEachChild(x, v); }; v(sf); return n; };
for (const item of cfg.files) {
  if (!item.edits?.length) continue;
  let out = item.out;
  const lines = [];
  for (const [module, names] of item.newImports) lines.push(`import { ${[...names].sort().join(", ")} } from "${rel(item.file, module)}";`);
  const hasTx = item.edits.some((e) => e.kind === "tx"), hasBare = item.edits.some((e) => e.kind === "bare"), hasCron = item.edits.some((e) => e.kind === "cron");
  if (hasTx || hasBare) lines.push(`import { ${[hasBare ? "defaultDb" : null, hasTx ? "runInTransaction" : null].filter(Boolean).join(", ")} } from "${rel(item.file, DB_HANDLE)}";`);
  if (hasCron) { const names = new Set(item.edits.filter((e) => e.kind === "cron").map((e) => e.alias)); lines.push(`import { ${[...names].sort().join(", ")} } from "${rel(item.file, CRON)}";`); }
  const ports = item.edits.filter((e) => e.kind === "port"); if (ports.length) lines.push(`import { ${[...new Set(ports.map((e) => e.alias))].sort().join(", ")} } from "${rel(item.file, PORTS)}";`);
  const at = lastImportEnd(out);
  out = out.slice(0, at) + "\n" + lines.join("\n") + out.slice(at);
  // drop import specifiers that are no longer referenced
  const sf = ts.createSourceFile("x.ts", out, ts.ScriptTarget.Latest, true);
  const cuts = [];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    const c = st.importClause; const keepDefault = c.name && identUsed(out, c.name.text); const nb = c.namedBindings;
    let keepNamed = [], dropAll = false;
    if (nb && ts.isNamedImports(nb)) keepNamed = nb.elements.filter((e) => identUsed(out, e.name.text));
    else if (nb && ts.isNamespaceImport(nb)) { if (!identUsed(out, nb.name.text)) dropAll = !keepDefault; else keepNamed = [nb]; }
    const anyUsed = keepDefault || keepNamed.length;
    if (!anyUsed || dropAll) { cuts.push([st.getFullStart(), st.getEnd(), ""]); continue; }
    const toType = (e) => !c.isTypeOnly && !e.isTypeOnly && !identUsed(out, e.name.text, false, true);
    if (nb && ts.isNamedImports(nb) && (keepNamed.length !== nb.elements.length || keepNamed.some(toType))) {
      const typePrefix = c.isTypeOnly ? "type " : "";
      cuts.push([st.getStart(sf), st.getEnd(), `import ${typePrefix}${keepDefault ? c.name.text + (keepNamed.length ? ", " : "") : ""}${keepNamed.length ? `{ ${keepNamed.map((e) => (toType(e) ? "type " : "") + e.getText(sf)).join(", ")} }` : ""} from ${st.moduleSpecifier.getText(sf)};`]);
    }
  }
  for (const [s, e, t] of cuts.sort((a, b) => b[0] - a[0])) out = out.slice(0, s) + t + out.slice(e);
  fs.writeFileSync(abs(item.file), out.replace(/\n{4,}/g, "\n\n\n"));
}
console.log("applied.");
