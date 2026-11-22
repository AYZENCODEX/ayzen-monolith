/**
 * build/import-graph.mjs — W2-P2: a small install-free import-graph walker for the SPA (alias "@" -> src). It follows static
 * imports, re-exports and dynamic import("...") with string literals, ignores packages, and lets the caller replace chosen
 * files with stubs (not traversed) — which is exactly what a module build does to other modules' pages.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const SPEC = /(?:import|export)\s[^"';]*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
const EXTS = [".tsx", ".ts", ".jsx", ".js", ".mjs"];

export function stripComments(src) {
  // Single pass that keeps string literals, so "/*" inside a string or a "//" inside a URL does not eat code.
  let out = "", i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1); i = j + 1;
    } else if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i++; }
    else if (c === "/" && n === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 2; }
    else { out += c; i++; }
  }
  return out;
}

export function resolveSpecifier(spec, importerFile, srcRoot) {
  let base;
  if (spec.startsWith("@/")) base = join(srcRoot, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(importerFile), spec);
  else return null; // a package or a workspace package: not part of the page graph
  const candidates = [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => join(base, "index" + e))];
  return candidates.find((p) => existsSync(p) && statSync(p).isFile()) ?? null;
}

export function importsOf(file, srcRoot) {
  const src = stripComments(readFileSync(file, "utf8"));
  const out = [];
  for (const m of src.matchAll(SPEC)) {
    const spec = m[1] ?? m[2] ?? m[3];
    const target = resolveSpecifier(spec, file, srcRoot);
    if (target) out.push(target);
  }
  return out;
}

/** Reachable files from `entry`; files in `stubbed` (absolute paths) are recorded but never opened. */
export function walk(entry, srcRoot, stubbed = new Set()) {
  const seen = new Set(), hitStubs = new Set(), importersOfStubs = new Map();
  const queue = [entry];
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const t of importsOf(f, srcRoot)) {
      if (stubbed.has(t)) { hitStubs.add(t); (importersOfStubs.get(t) ?? importersOfStubs.set(t, new Set()).get(t)).add(f); continue; }
      queue.push(t);
    }
  }
  return { reachable: seen, hitStubs, importersOfStubs };
}
