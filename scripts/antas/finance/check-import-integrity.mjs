#!/usr/bin/env node
// FIN-WP-9: relative-import and re-export integrity over artifacts/api-server/src, using the TypeScript
// compiler API. This is NOT a typecheck and does not replace `pnpm typecheck` / `pnpm build`.
//
// It exists for the case that cost WP-7 and WP-8 their PASS: a checkout where dependencies cannot be
// installed, so a wrong re-export name or a missing relative file would stay invisible until `tsc` runs.
// External packages stay unresolved here, so only diagnostics about the repository's own modules are kept:
//   - syntax errors
//   - a relative specifier that resolves to no file (TS2307)
//   - a named import or re-export that the target module does not export (TS2305, TS2724, TS2614, TS2459, TS2460)
//   - duplicate names produced by `export *` or conflicting re-exports (TS2308, TS2300)
//
//   node scripts/antas/finance/check-import-integrity.mjs            # prints JSON, exit 1 on findings
// TypeScript is taken from the repository's node_modules when installed, else from NODE_PATH / the global
// install (set TYPESCRIPT_PATH to a directory that contains `typescript` to force one).
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] ?? path.join(here, "../../.."));

function loadTypescript() {
  const candidates = [
    process.env.TYPESCRIPT_PATH && path.join(process.env.TYPESCRIPT_PATH, "/"),
    path.join(root, "artifacts/api-server/"),
    path.join(root, "/"),
    ...(process.env.NODE_PATH ?? "").split(path.delimiter).filter(Boolean).map((p) => path.join(p, "/")),
  ].filter(Boolean);
  for (const base of candidates) {
    try { return createRequire(base)("typescript"); } catch { /* try the next location */ }
  }
  try { return createRequire(import.meta.url)("typescript"); } catch { /* fall through */ }
  console.error("typescript not found: install dependencies, or set TYPESCRIPT_PATH to a directory containing it");
  process.exit(2);
}

const ts = loadTypescript();
const srcDir = path.join(root, "artifacts/api-server/src");
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  if (e.name === "node_modules" || e.name === "dist") return [];
  const full = path.join(d, e.name);
  return e.isDirectory() ? walk(full) : /\.(ts|tsx|mts)$/.test(e.name) && !e.name.endsWith(".d.ts") ? [full] : [];
});
const files = walk(srcDir);
const options = {
  noEmit: true,
  isolatedModules: true,
  lib: ["lib.es2022.d.ts"],
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2022,
  skipLibCheck: true,
  types: [],
  allowImportingTsExtensions: true,
};
const program = ts.createProgram(files, options);

const EXPORT_CODES = new Set([2305, 2724, 2614, 2459, 2460, 2308, 2300]);
const findings = [];
for (const sf of program.getSourceFiles()) {
  if (!sf.fileName.startsWith(srcDir)) continue;
  for (const d of [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)]) {
    if (d.category !== ts.DiagnosticCategory.Error) continue;
    const message = ts.flattenDiagnosticMessageText(d.messageText, " ");
    const { line } = sf.getLineAndCharacterOfPosition(d.start ?? 0);
    const where = { file: path.relative(root, sf.fileName).split(path.sep).join("/"), line: line + 1, code: d.code, message };
    if (d.code < 2000) findings.push({ kind: "syntax", ...where });
    else if (d.code === 2307 && /Cannot find module '\.{1,2}\//.test(message)) findings.push({ kind: "missing-relative-module", ...where });
    else if (EXPORT_CODES.has(d.code)) findings.push({ kind: "export-integrity", ...where });
  }
}

console.log(JSON.stringify({
  check: "finance-import-integrity",
  note: "Partial check, not a typecheck: external packages are unresolved.",
  typescript: ts.version,
  filesChecked: files.length,
  findings,
}, null, 2));
process.exitCode = findings.length ? 1 : 0;
