// MKT-01a: static facts about the CURRENT Marketplace route code, extracted from source text (comments removed first).
// These facts are pinned in pins.json by characterize.test.mjs. They record what the code does today, defects included
// (see MKT-ISSUE-6 and MKT-ISSUE-7 in boundaries.manifest.json). They are not proof of correct behavior and they do not
// run any handler: a database-backed suite (MKT-01b) is still required.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
export const routeDir = path.join(root, "artifacts/api-server/src/routes");
const read = (f) => fs.readFileSync(f, "utf8");

/** Removes // and block comments, keeping string and template contents and line structure. */
export function stripComments(text) {
  let out = "", i = 0, q = null;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (q) {
      out += c;
      if (c === "\\") { out += n ?? ""; i += 2; continue; }
      if (c === q) q = null;
      i++; continue;
    }
    if (c === '"' || c === "'" || c === "`") { q = c; out += c; i++; continue; }
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) { if (text[i] === "\n") out += "\n"; i++; } i += 2; continue; }
    out += c; i++;
  }
  return out;
}
const norm = (s) => s.replace(/\s+/g, " ").trim();

export function feeConstants(code) {
  const out = {};
  for (const m of code.matchAll(/\bconst\s+([A-Z_]*FEE[A-Z_]*)\s*=\s*([\d.]+)/g)) out[m[1]] = Number(m[2]);
  return out;
}
/** MKT-03: fee constants now come from the kernel: { LOCAL_CONST: market }. */
export function feePolicyBindings(code) {
  const out = {};
  for (const m of code.matchAll(/\bconst\s+([A-Z_]*FEE[A-Z_]*)\s*=\s*DEFAULT_FEE_PCT\.(\w+)/g)) out[m[1]] = m[2];
  return out;
}
export const kernelMoneyCalls = (code) => code.split("\n").filter((l) => /\b(feeByFraction|feeByProduct|feeRounded4)\(/.test(l)).map(norm);
export const percentExpressions = (code) => code.split("\n").filter((l) => /\/\s*100\b/.test(l)).map(norm).filter(Boolean);
export const roundingSites = (code) => code.split("\n").filter((l) => /\.toFixed\(|Math\.(round|floor|ceil)\(/.test(l)).map(norm);
export function statusLiterals(code) {
  return [...new Set([...code.matchAll(/\bstatus\s*(?:=|!=|<>)\s*'(\w+)'/gi)].map((m) => m[1]))].sort();
}
/** Ordered write statements, e.g. ["INSERT marketplace_orders", "UPDATE credits"], consecutive duplicates collapsed. */
export function writeSequence(code) {
  const seq = [];
  for (const m of code.matchAll(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public\.)?([a-z_][a-z0-9_]*)\b/gi)) {
    const kind = m[1].toUpperCase().startsWith("INSERT") ? "INSERT" : m[1].toUpperCase().startsWith("UPDATE") ? "UPDATE" : "DELETE";
    if (kind === "UPDATE" && !/^\s*(SET\b)/i.test(code.slice(m.index + m[0].length, m.index + m[0].length + 6)) && !/^\s+SET\b/i.test(code.slice(m.index + m[0].length, m.index + m[0].length + 8))) continue;
    const tok = `${kind} ${m[2].toLowerCase()}`;
    if (seq[seq.length - 1] !== tok) seq.push(tok);
  }
  return seq;
}
/** Transaction and lock sequence in source order: BEGIN, LOCK:<table>, COMMIT, ROLLBACK. */
export function txSequence(code) {
  const events = [];
  for (const m of code.matchAll(/\.query\(\s*["'`](BEGIN|COMMIT|ROLLBACK)["'`]/g)) events.push([m.index, m[1]]);
  for (const m of code.matchAll(/FOR UPDATE/g)) {
    const before = code.slice(Math.max(0, m.index - 500), m.index);
    const from = [...before.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi)].pop();
    events.push([m.index, `LOCK:${from ? from[1].toLowerCase() : "?"}`]);
  }
  return events.sort((a, b) => a[0] - b[0]).map((e) => e[1]);
}
export function stringLiterals(code) {
  const out = []; let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1, buf = "";
      while (j < code.length && code[j] !== c) { if (code[j] === "\\") { buf += code[j] + (code[j + 1] ?? ""); j += 2; continue; } buf += code[j++]; }
      out.push(buf); i = j + 1;
    } else i++;
  }
  return out;
}
/** Guard facts: SQL debits (balance/amount decreases) with and without a `>=` predicate in the same statement. */
export function debitGuards(code) {
  const stmts = stringLiterals(code).filter((s) => /\b(?:balance\s*=\s*balance\s*-|azn_balance\s*=\s*azn_balance\s*-|amount\s*=\s*amount\s*-)/i.test(s) && /\bSET\b/i.test(s));
  return { debits: stmts.length, guarded: stmts.filter((s) => />=/.test(s)).length };
}
/** Balanced-paren scan of every res.json(...) / res.status(N).json(...) call: [status, sorted top-level keys]. */
export function responseShapes(code) {
  const shapes = new Set();
  for (const m of code.matchAll(/\bres\s*(?:\.status\(\s*(\d{3})\s*\))?\s*\.json\(/g)) {
    let i = m.index + m[0].length, depth = 1, q = null, start = i;
    while (i < code.length && depth > 0) {
      const c = code[i];
      if (q) { if (c === "\\") i++; else if (c === q) q = null; }
      else if (c === '"' || c === "'" || c === "`") q = c;
      else if (c === "(" || c === "{" || c === "[") depth++;
      else if (c === ")" || c === "}" || c === "]") depth--;
      i++;
    }
    const arg = code.slice(start, i - 1).trim();
    let keys = null;
    if (arg.startsWith("{")) {
      const inner = arg.slice(1, arg.lastIndexOf("}"));
      const ks = []; let d = 0, qq = null, tok = "";
      const flush = () => { const t = tok.trim(); if (t) { const k = t.match(/^(?:\.\.\.)?(["']?)([\w$]+)\1\s*(?::|$|,)/) ; ks.push(t.startsWith("...") ? "..." + (t.slice(3).match(/^[\w$.]+/)?.[0] ?? "") : (k ? k[2] : t.split(":")[0].trim())); } tok = ""; };
      for (let j = 0; j < inner.length; j++) {
        const c = inner[j];
        if (qq) { tok += c; if (c === "\\") { tok += inner[++j] ?? ""; } else if (c === qq) qq = null; continue; }
        if (c === '"' || c === "'" || c === "`") { qq = c; tok += c; continue; }
        if (c === "(" || c === "{" || c === "[") d++;
        if (c === ")" || c === "}" || c === "]") d--;
        if (c === "," && d === 0) { flush(); continue; }
        tok += c;
      }
      flush();
      keys = [...new Set(ks)].sort().join(",");
    }
    shapes.add(keys === null ? `${m[1] ?? "200"} <non-object>` : `${m[1] ?? "200"} {${keys}}`);
  }
  return [...shapes].sort();
}

/** Splits a route file's (comment-stripped) code into one slice per `router.<method>("<path>"` declaration, keyed "METHOD /path". */
export function routeSlices(code) {
  const idx = [...code.matchAll(/router\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)];
  const out = {};
  idx.forEach((m, i) => { out[`${m[1].toUpperCase()} ${m[2]}`] = code.slice(m.index, i + 1 < idx.length ? idx[i + 1].index : code.length); });
  return out;
}
/** Literals that carry SQL, including the pieces of dynamically assembled statements. */
export const sqlishLiterals = (code) => stringLiterals(code).map((s) => s.replace(/\s+/g, " ").trim()).filter((s) => /\b(SELECT|INSERT|UPDATE|DELETE|WHERE|ORDER BY|FROM|LIMIT|AND|ILIKE)\b/.test(s));

/** MKT-ISSUE-8: `return` statements between BEGIN and the first COMMIT with no ROLLBACK in the three lines before them. */
export function unrolledEarlyReturns(code) {
  const body = code.split("\n");
  const b = body.findIndex((l) => /\.query\(\s*["'`]BEGIN["'`]/.test(l));
  if (b < 0) return [];
  const c = body.findIndex((l, i) => i > b && /\.query\(\s*["'`]COMMIT["'`]/.test(l));
  const out = [];
  for (let k = b + 1; k < (c < 0 ? body.length : c); k++) {
    if (/\breturn\s*(;|\{)/.test(body[k]) && !/ROLLBACK/.test(body.slice(Math.max(b + 1, k - 3), k + 1).join(" "))) out.push(norm(body[k]).slice(0, 120));
  }
  return out;
}

/** Splits a route file into per-route code bodies using the MKT-00 migration map lines. */
export function collectFacts() {
  // The migration map holds the line number of every route; regenerate it so the facts always describe the current tree.
  const gen = spawnSync(process.execPath, [path.join(root, "scripts/antas/marketplace/generate-inventory.mjs")], { encoding: "utf8" });
  if (gen.status !== 0) throw new Error("generate-inventory failed: " + (gen.stdout + gen.stderr).slice(-400));
  const map = JSON.parse(read(path.join(root, "reports/antas/marketplace/marketplace-migration-map.json")));
  const byFile = new Map();
  for (const r of map.routes) (byFile.get(r.file) ?? byFile.set(r.file, []).get(r.file)).push(r);
  const files = {}, routes = {}, readOnlyRoutes = {};
  for (const [file, rs] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
    const raw = read(path.join(routeDir, file));
    const code = stripComments(raw);
    // line numbers refer to the raw file, so cut the raw text first, then strip each slice
    const rawLines = raw.split("\n");
    rs.sort((a, b) => a.line - b.line);
    files[file] = {
      feeConstants: feeConstants(code), feePolicyBindings: feePolicyBindings(code), kernelMoneyCalls: kernelMoneyCalls(code), percentExpressions: percentExpressions(code), roundingSites: roundingSites(code),
      statusLiterals: statusLiterals(code), debitGuards: debitGuards(code), lockOrderInFile: txSequence(code).filter((e) => e.startsWith("LOCK:")),
    };
    rs.forEach((r, i) => {
      const slice = stripComments(rawLines.slice(r.line - 1, i + 1 < rs.length ? rs[i + 1].line - 1 : rawLines.length).join("\n"));
      const writes = writeSequence(slice), tx = txSequence(slice), shapes = responseShapes(slice);
      const unrolled = unrolledEarlyReturns(slice);
      if (writes.length || tx.length) routes[`${r.method} ${r.path} ${file}`] = { writes, tx, responses: shapes, ...(unrolled.length ? { unrolledEarlyReturns: unrolled } : {}) };
      else readOnlyRoutes[`${r.method} ${r.path} ${file}`] = { responses: shapes };
    });
  }
  const real = map.realFloatColumns.map((c) => `${c.table}.${c.column}`).sort();
  return { files, routes, readOnlyRoutes, realFloatColumns: real };
}
