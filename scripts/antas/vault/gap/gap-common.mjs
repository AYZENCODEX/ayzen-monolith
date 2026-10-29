// Shared helpers for VLT-GAP validators (01-B onward).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
export const sha256File = (abs) => sha256(fs.readFileSync(abs));
export const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join("/");

const BYPASS_ARGS = /^--(skip|skip-validation|skip-tests|force|force-pass|ignore-failures|continue-on-error|no-verify|bypass|disable|dry-run|pass|assume-pass|no-tests|allow-failure)/i;
const BYPASS_ENV = /(SKIP|BYPASS|DISABLE|FORCE|IGNORE|NOVALIDATE|ASSUME_PASS|CONTINUE_ON_ERROR)/i;
export function rejectBypass(allowedFlags = ["--verify"]) {
  const hits = [];
  for (const a of process.argv.slice(2)) {
    if (allowedFlags.includes(a)) continue;
    if (BYPASS_ARGS.test(a)) hits.push(`arg ${a}`);
    else if (a.startsWith("-")) hits.push(`unknown flag ${a}`);
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (!v || /^(0|false|no)$/i.test(v)) continue;
    if ((/^(ANTAS|VLT|VAULT|VALIDATION|CI_)/i.test(k)) && BYPASS_ENV.test(k)) hits.push(`env ${k}=${v}`);
  }
  return hits;
}
export const isBypassArg = (a) => BYPASS_ARGS.test(a);

export function gitSha() {
  const r = spawnSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}
export function binding(hashes) {
  const sha = gitSha();
  const tree = sha256(Object.entries(hashes).sort().map(([k, v]) => `${k}:${v}`).join("\n"));
  return sha
    ? { commit_sha: sha, commit_binding: "git-head", source_tree_sha256: tree }
    : { commit_sha: null, commit_binding: "source-tree-hash (no git repository available)", source_tree_sha256: tree };
}

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "reports", "docs", ".turbo", "coverage", ".next", "build"]);
export function walkFiles(dir = ROOT, out = [], filter = () => true) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out, filter);
    else if (filter(p)) out.push(p);
  }
  return out;
}

// VLT-GAP-01-D: files created by the retirement extraction (paths relative to artifacts/api-server/src).
export const GAP01D_NEW_FILES = ["create", "update", "bulk", "analytics", "activity-feed", "admin", "receipt"].map((n) => `vault/application/entity/${n}.ts`);
