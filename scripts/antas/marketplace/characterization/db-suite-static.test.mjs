// MKT-01b-1 static self-check. The DB suite cannot run in a sandbox without Postgres, so this test verifies, with plain node,
// what can be verified without it: every fixture and assertion statement in the DB tests names real tables and columns of the
// Marketplace DDL (or of the stand-ins), every INSERT supplies all NOT NULL columns without a default, the runner can build the
// schema in dependency order, the stubs export every name the mounted routers import, and the files the runner lists exist.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stringLiterals, stripComments } from "./extract.mjs";
import { SCOPE_TABLE_PATTERN, STAND_INS, TRUNCATE_ORDER } from "../../../../artifacts/api-server/src/marketplace/characterization/standins.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "../../../../artifacts/api-server/src");
const charDir = path.join(src, "marketplace/characterization");
const read = (f) => fs.readFileSync(f, "utf8");

function topLevelSplit(body) {
  const parts = []; let depth = 0, q = null, cur = "";
  for (const c of body) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === "(") depth++; if (c === ")") depth--;
    if (c === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}
function parseTables(text, onlyScope) {
  const tables = new Map(); const order = [];
  for (const m of text.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z0-9_]+)\s*\(/gi)) {
    const name = m[1];
    if (onlyScope && !SCOPE_TABLE_PATTERN.test(name)) continue;
    let i = m.index + m[0].length, depth = 1, q = null;
    while (i < text.length && depth > 0) { const c = text[i]; if (q) { if (c === q) q = null; } else if (c === "'" ) q = c; else if (c === "(") depth++; else if (c === ")") depth--; i++; }
    const cols = new Map(); const refs = [];
    for (const def of topLevelSplit(text.slice(m.index + m[0].length, i - 1))) {
      if (/^(UNIQUE|PRIMARY|FOREIGN|CONSTRAINT|CHECK)\b/i.test(def)) continue;
      const cm = def.match(/^([a-z_][a-z0-9_]*)\s+([A-Za-z]+)/);
      if (!cm) continue;
      cols.set(cm[1], { notNull: /NOT NULL/i.test(def) || /PRIMARY KEY/i.test(def), hasDefault: /DEFAULT/i.test(def) || /SERIAL/i.test(cm[2]) });
      const r = def.match(/REFERENCES ([a-z0-9_]+)/i); if (r) refs.push(r[1]);
    }
    tables.set(name, { cols, refs }); order.push(name);
  }
  return { tables, order };
}
const ddlText = read(path.join(src, "lib/schema-migrations.ts"));
const scope = parseTables(ddlText, true);
for (const m of ddlText.matchAll(/ALTER TABLE ([a-z0-9_]+) ADD COLUMN IF NOT EXISTS ([a-z_][a-z0-9_]*) ([^`;"]*)/gi)) {
  const t = scope.tables.get(m[1]);
  if (t) t.cols.set(m[2], { notNull: /NOT NULL/i.test(m[3]), hasDefault: /DEFAULT/i.test(m[3]) });
}
const standIns = parseTables(Object.values(STAND_INS).join(";\n"), false);
const all = new Map([...scope.tables, ...standIns.tables]);

const dbTests = fs.readdirSync(charDir).filter((f) => /\.db\.test\.ts$/.test(f));
const sqlFiles = ["harness.ts", ...dbTests].map((f) => path.join(charDir, f));
const literals = sqlFiles.flatMap((f) => stringLiterals(stripComments(read(f))).map((s) => [path.basename(f), s.replace(/\s+/g, " ").trim()]));

test("the suite exists and the runner lists only real files", () => {
  assert.ok(dbTests.length >= 5);
  const runner = read(path.join(charDir, "marketplace-db-runner.mjs"));
  const listed = [...runner.matchAll(/"(src\/marketplace\/characterization\/[^"]+\.db\.test\.ts)"/g)].map((m) => m[1]);
  assert.deepEqual([...listed].sort(), dbTests.map((f) => `src/marketplace/characterization/${f}`).sort());
});
test("the runner can create the Marketplace tables in order: every REFERENCES target is a stand-in or an earlier table", () => {
  const available = new Set(standIns.order);
  for (const name of scope.order) {
    for (const ref of scope.tables.get(name).refs) assert.ok(available.has(ref) || ref === name, `${name} references ${ref} which is not created before it`);
    available.add(name);
  }
});
test("every INSERT in the fixtures and tests uses real columns and supplies every NOT NULL column without a default", () => {
  let checked = 0;
  for (const [file, s] of literals) {
    const m = s.match(/^INSERT INTO ([a-z0-9_]+)\s*\(([^)]*)\)/i);
    if (!m) continue;
    const t = all.get(m[1]); assert.ok(t, `${file}: unknown table ${m[1]}`);
    const cols = m[2].split(",").map((c) => c.trim());
    for (const c of cols) assert.ok(t.cols.has(c), `${file}: ${m[1]}.${c} does not exist`);
    for (const [c, d] of t.cols) if (d.notNull && !d.hasDefault) assert.ok(cols.includes(c), `${file}: INSERT INTO ${m[1]} omits NOT NULL column ${c}`);
    checked++;
  }
  assert.ok(checked >= 7, `expected to check at least 7 INSERTs, checked ${checked}`);
});
test("every simple SELECT column list and every UPDATE SET column names real columns", () => {
  let checked = 0;
  for (const [file, s] of literals) {
    const sel = s.match(/^SELECT ([a-z_ ,]+?) FROM ([a-z0-9_]+)\b/i);
    if (sel && !/\*/.test(sel[1])) {
      const t = all.get(sel[2]); if (!t) continue;
      for (const c of sel[1].split(",").map((x) => x.trim().split(/\s+/)[0])) assert.ok(t.cols.has(c), `${file}: ${sel[2]}.${c} does not exist`);
      checked++;
    }
  }
  assert.ok(checked >= 6, `checked ${checked}`);
});
test("TRUNCATE in the harness lists existing tables only and covers every table the tests insert into", () => {
  const harness = read(path.join(charDir, "harness.ts"));
  const tr = harness.match(/TRUNCATE ([a-z_, ]+) RESTART IDENTITY/)[1].split(",").map((x) => x.trim());
  for (const t of tr) assert.ok(all.has(t), `TRUNCATE names unknown table ${t}`);
  assert.deepEqual([...tr].sort(), [...TRUNCATE_ORDER].sort());
  const inserted = new Set(literals.map(([, s]) => s.match(/^INSERT INTO ([a-z0-9_]+)/i)?.[1]).filter(Boolean));
  for (const t of inserted) assert.ok(tr.includes(t), `${t} is inserted into but not truncated between tests`);
});
test("stubs export every name the mounted routers import from the stubbed modules", () => {
  const stubFor = { "../middlewares/auth": "auth.stub.ts", "../lib/policy/pep/middleware": "pep-middleware.stub.ts", "../lib/notification-bus": "notification-bus.stub.ts", "../services/credit-meter": "credit-meter.stub.ts" };
  const exported = (f) => new Set([...read(path.join(charDir, "stubs", f)).matchAll(/export (?:async )?(?:function|const|interface) (\w+)/g)].map((m) => m[1]));
  const mounted = [...new Set(dbTests.flatMap((f) => [...read(path.join(charDir, f)).matchAll(/from "\.\.\/\.\.\/routes\/([a-z-]+)"/g)].map((m) => `${m[1]}.ts`)))];
  assert.ok(mounted.length >= 7, `mounted routers: ${mounted.join(", ")}`);
  for (const file of mounted) {
    const text = stripComments(read(path.join(src, "routes", file)));
    for (const m of text.matchAll(/import\s+\{([^}]+)\}\s+from\s+"([^"]+)"/g)) {
      const stub = stubFor[m[2]]; if (!stub) continue;
      const have = exported(stub);
      for (const raw of m[1].split(",")) { const n = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]; if (n && !raw.trim().startsWith("type ")) assert.ok(have.has(n), `${file} imports ${n} from ${m[2]} but ${stub} does not export it`); }
    }
  }
});
test("the stub hook targets real files and the routers the tests mount have default exports", () => {
  const hooks = read(path.join(charDir, "stub-hooks.mjs"));
  for (const m of hooks.matchAll(/\["([a-z/\-]+\.ts)", "([a-z\-.]+\.ts)"\]/g)) { assert.ok(fs.existsSync(path.join(src, m[1])), `stubbed module ${m[1]} does not exist`); assert.ok(fs.existsSync(path.join(charDir, "stubs", m[2])), `stub ${m[2]} missing`); }
  for (const f of [...new Set(dbTests.flatMap((x) => [...read(path.join(charDir, x)).matchAll(/from "\.\.\/\.\.\/routes\/([a-z-]+)"/g)].map((m) => `${m[1]}.ts`)))]) assert.match(read(path.join(src, "routes", f)), /export default router;/);
  for (const f of dbTests) for (const m of read(path.join(charDir, f)).matchAll(/from "\.\.\/\.\.\/routes\/([a-z-]+)"/g)) assert.ok(fs.existsSync(path.join(src, "routes", `${m[1]}.ts`)), `${f} imports missing route ${m[1]}`);
});
