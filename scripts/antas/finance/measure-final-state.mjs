#!/usr/bin/env node
// FIN-WP-9: re-measure the Finance extraction from the tree (no database, no network, no dependencies).
// Prints JSON; exit 1 only when a hard "done" condition is violated (writes in routes, legacy lib files,
// real importers of a removed module). Counts are static: route handlers are `router.<verb>(` lines.
//   node scripts/antas/finance/measure-final-state.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const api = path.join(root, "artifacts/api-server/src");
const rel = (p) => path.relative(root, p).split(path.sep).join("/");
const read = (p) => fs.readFileSync(p, "utf8");
const walk = (dir, accept) => {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name === "dist" || e.name === ".git") return [];
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full, accept) : accept(full) ? [full] : [];
  });
};
const lines = (text) => (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");

// 1. Route handlers and direct db.* usage in the two Finance route files.
const routeFiles = ["routes/finance.ts", "routes/finance-invoices.ts"];
const routes = routeFiles.map((f) => {
  const text = read(path.join(api, f));
  const ls = lines(text);
  const handlers = ls.filter((l) => /^\s*router\.(get|post|put|patch|delete)\(/.test(l)).length;
  const dbLines = ls
    .map((l, i) => ({ line: i + 1, text: l.trim() }))
    .filter((x) => /\bdb\.(select|insert|update|delete|execute|transaction)\b/.test(x.text));
  return {
    file: `artifacts/api-server/src/${f}`,
    handlers,
    lines: ls.length,
    dbLines: dbLines.map((x) => x.line),
    dbWriteLines: dbLines.filter((x) => /\bdb\.(insert|update|delete|execute|transaction)\b/.test(x.text)).map((x) => x.line),
  };
});

// 2. Target tree under finance/: non-test source files and lines per directory.
const financeDir = path.join(api, "finance");
const treeFiles = walk(financeDir, (p) => p.endsWith(".ts") && !p.endsWith(".d.ts"));
const isTest = (p) => /\.test\.ts$/.test(p);
const byDir = {};
for (const f of treeFiles) {
  const d = path.relative(financeDir, path.dirname(f)).split(path.sep).join("/") || "(root)";
  byDir[d] ??= { sources: 0, sourceLines: 0, tests: 0 };
  if (isTest(f)) byDir[d].tests += 1;
  else { byDir[d].sources += 1; byDir[d].sourceLines += lines(read(f)).length; }
}
const sources = treeFiles.filter((f) => !isTest(f));
const targetTree = {
  sourceFiles: sources.length,
  sourceLines: sources.reduce((n, f) => n + lines(read(f)).length, 0),
  testFiles: treeFiles.filter(isTest).length,
  directoriesWithSources: Object.entries(byDir).filter(([d, v]) => d !== "(root)" && v.sources > 0).length,
  byDirectory: Object.fromEntries(Object.entries(byDir).sort(([a], [b]) => a.localeCompare(b))),
};

// 3. Legacy lib/finance-* files and importers of the removed modules.
const removed = [
  "finance-accounting", "finance-ai", "finance-digest-cron", "finance-invoice", "finance-invoice-reminder-cron",
  "finance-late-fee-cron", "finance-networth", "finance-networth-cron", "finance-notify", "finance-recurring-cron",
  "finance-reminder-cron", "finance-report-schedule-cron", "finance-wallet-bridge", "invoice-pdf",
];
const libDir = path.join(api, "lib");
const legacyLibFiles = fs.readdirSync(libDir).filter((n) => /^finance-.+\.(ts|mjs)$/.test(n) || n === "invoice-pdf.ts");
const removedStillPresent = removed.filter((n) => fs.existsSync(path.join(libDir, `${n}.ts`)));
const importRe = new RegExp(`^\\s*(?:import|export)\\b[^\\n]*\\bfrom\\s+["'][^"']*/lib/(?:${removed.join("|")})(?:\\.[a-z]+)?["']`);
const dynRe = new RegExp(`(?:import|require)\\(\\s*["'][^"']*/lib/(?:${removed.join("|")})(?:\\.[a-z]+)?["']`);
const importerRe = new RegExp(`from\\s+["'][^"']*/(?:${removed.join("|")})(?:\\.[a-z]+)?["']`);
// Known false positive: a string fixture inside a test of an import parser, not a real import.
const fixtureAllowlist = new Set(["tools/lineage-builder/test/lib.test.mjs"]);
const scanRoots = ["artifacts", "services", "scripts", "lib", "apps", "packages", "tools", "tests"].map((d) => path.join(root, d));
const importers = [];
const ignoredFixtures = [];
for (const f of scanRoots.flatMap((d) => walk(d, (p) => /\.(ts|tsx|mjs|js|cjs)$/.test(p)))) {
  const r = rel(f);
  if (r === "scripts/antas/finance/validate-boundaries.mjs" || r === "scripts/antas/finance/measure-final-state.mjs") continue;
  read(f).split("\n").forEach((l, i) => {
    if (importRe.test(l) || dynRe.test(l) || (/^\s*(?:import|export)\b/.test(l) && importerRe.test(l) && /\/lib\//.test(l))) {
      (fixtureAllowlist.has(r) ? ignoredFixtures : importers).push(`${r}:${i + 1}`);
    }
  });
}

// 4. Evidence status counts.
const evDir = path.join(root, "reports/antas/finance");
const evidence = fs.readdirSync(evDir).filter((n) => /-evidence\.json$/.test(n)).sort().map((n) => {
  const j = JSON.parse(read(path.join(evDir, n)));
  return { file: n, phase: j.phase ?? j.id ?? "?", status: j.status, notRun: (j.notRun ?? []).length };
});
const statusCounts = evidence.reduce((m, e) => ((m[e.status] = (m[e.status] ?? 0) + 1), m), {});

const result = {
  measuredAt: new Date().toISOString(),
  routes: {
    files: routes,
    totalHandlers: routes.reduce((n, r) => n + r.handlers, 0),
    directDbLines: routes.reduce((n, r) => n + r.dbLines.length, 0),
    directDbWriteLines: routes.reduce((n, r) => n + r.dbWriteLines.length, 0),
  },
  targetTree,
  legacy: { libFinanceFiles: legacyLibFiles, removedModulesStillPresent: removedStillPresent, importersOfRemovedModules: importers, ignoredFixtures },
  evidence: { files: evidence.length, statusCounts, list: evidence },
};
console.log(JSON.stringify(result, null, 2));
const violated = result.routes.directDbWriteLines > 0 || removedStillPresent.length > 0 || importers.length > 0
  || legacyLibFiles.some((n) => !/^finance-accounting\.db(-runner\.mjs|\.test\.ts)$/.test(n));
process.exitCode = violated ? 1 : 0;
