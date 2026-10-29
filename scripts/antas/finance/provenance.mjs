#!/usr/bin/env node
// Finance provenance manifest. Hashes Finance-owned files with git's blob algorithm
// (sha1 of "blob <bytes>\0" + content), so each entry equals `git hash-object <path>`
// and `git rev-parse <commit>:<path>` in a real checkout. Works without .git.
//   node scripts/antas/finance/provenance.mjs --write   regenerate the manifest
//   node scripts/antas/finance/provenance.mjs --verify  compare the tree to the manifest (default)
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const manifestPath = path.join(root, "reports/antas/finance/fin-provenance-manifest.json");
const include = [
  "artifacts/api-server/src/finance",
  "artifacts/api-server/src/routes/finance.ts",
  "artifacts/api-server/src/routes/finance-invoices.ts",
  "docs/antas/finance",
  "scripts/antas/finance",
];
const includeLibPrefix = "artifacts/api-server/src/lib/";
const libMatch = (name) => /^finance-.+\.(ts|mjs)$/.test(name) || name === "invoice-pdf.ts";

function walk(rel) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return [rel];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((entry) =>
    entry.name === "node_modules" || entry.name === "dist" ? [] : walk(path.posix.join(rel, entry.name)));
}
const gitBlob = (rel) => {
  const content = fs.readFileSync(path.join(root, rel));
  return crypto.createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
};
const files = [
  ...include.flatMap(walk),
  ...fs.readdirSync(path.join(root, includeLibPrefix)).filter(libMatch).map((n) => includeLibPrefix + n),
].filter((rel) => rel !== "scripts/antas/finance/provenance.mjs").sort();
const current = Object.fromEntries(files.map((rel) => [rel, gitBlob(rel)]));

if (process.argv.includes("--write")) {
  fs.writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    algorithm: "git-blob-sha1",
    baseSha: "93ed60540127c1a4819cf957bfc4ba415199bf48",
    baseShaSource: "reports/antas/finance/fin-02d-evidence.json (recorded in the Replit checkout that has .git)",
    note: "Hashes describe working-tree content. Compare with `git hash-object <path>` in the checkout; files that differ from `git rev-parse <baseSha>:<path>` are uncommitted work since the base.",
    files: current,
  }, null, 2) + "\n");
  console.log(`Wrote ${Object.keys(current).length} hashes to ${path.relative(root, manifestPath)}`);
} else {
  const recorded = JSON.parse(fs.readFileSync(manifestPath, "utf8")).files;
  const changed = Object.keys(current).filter((f) => recorded[f] !== current[f]);
  const missing = Object.keys(recorded).filter((f) => !(f in current));
  console.log(`Provenance verify: ${changed.length} changed, ${missing.length} missing, ${Object.keys(current).length} files`);
  for (const f of [...changed, ...missing]) console.log(`  ${f}`);
  process.exitCode = changed.length || missing.length ? 1 : 0;
}
