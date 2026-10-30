#!/usr/bin/env node
/**
 * scripts/src/check-module-registry.mjs
 * Module Shell Split, Season 1: parity check between the frontend module
 * registry (artifacts/ayzen/src/lib/subdomain-app.ts, SUBDOMAIN_APPS) and
 * the backend one (artifacts/api-server/src/lib/shared-apps.ts,
 * SHARED_APP_DEFINITIONS). Fails when ids, homePath or routePrefixes
 * differ, or when one prefix is claimed by two modules. Wired into CI as
 * a non-blocking warning first (see .github/workflows/ci.yml).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

function parseFrontend() {
  const src = readFileSync(join(root, "artifacts/ayzen/src/lib/subdomain-app.ts"), "utf8");
  const block = src.slice(src.indexOf("const SUBDOMAIN_APPS"), src.indexOf("};", src.indexOf("const SUBDOMAIN_APPS")));
  const apps = [];
  // each entry: id: { ... homePath: "...", routePrefixes: [...] }
  const entryRe = /\b(sylo|ryft|fyra|verve|skarn|zynth|warde|wisp):\s*\{([\s\S]*?)\n  \}/g;
  let m;
  while ((m = entryRe.exec(block)) !== null) {
    const id = m[1];
    // strip comment lines so example paths in prose never count as prefixes
    const body = m[2].split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    const home = body.match(/homePath:\s*"([^"]+)"/);
    const rp = body.match(/routePrefixes:\s*\[([^\]]*)\]/);
    const prefixes = rp ? [...rp[1].matchAll(/"(\/[a-z0-9-]+)"/g)].map((x) => x[1]) : [];
    if (home) apps.push({ id, homePath: home[1], routePrefixes: prefixes });
  }
  return apps;
}

function parseBackend() {
  const src = readFileSync(join(root, "artifacts/api-server/src/lib/shared-apps.ts"), "utf8");
  const block = src.slice(src.indexOf("SHARED_APP_DEFINITIONS:"), src.indexOf("\n];"));
  const apps = [];
  const entryRe = /\{\s*id:\s*"(\w+)",\s*label:\s*"[^"]*",\s*homePath:\s*"([^"]+)",\s*routePrefixes:\s*\[([^\]]*)\][^}]*\}/g;
  let m;
  while ((m = entryRe.exec(block)) !== null) {
    const prefixes = [...m[3].matchAll(/"(\/[a-z0-9-]+)"/g)].map((x) => x[1]);
    apps.push({ id: m[1], homePath: m[2], routePrefixes: prefixes });
  }
  return apps;
}

const fe = parseFrontend();
const be = parseBackend();
const errors = [];

const feIds = fe.map((a) => a.id).sort();
const beIds = be.map((a) => a.id).sort();
if (JSON.stringify(feIds) !== JSON.stringify(beIds)) {
  errors.push(`module id sets differ: frontend=[${feIds}] backend=[${beIds}]`);
}

for (const b of be) {
  const f = fe.find((x) => x.id === b.id);
  if (!f) continue;
  if (f.homePath !== b.homePath) errors.push(`${b.id}: homePath differs (frontend=${f.homePath} backend=${b.homePath})`);
  const fp = [...f.routePrefixes].sort().join(",");
  const bp = [...b.routePrefixes].sort().join(",");
  if (fp !== bp) errors.push(`${b.id}: routePrefixes differ (frontend=[${fp}] backend=[${bp}])`);
}

const seen = new Map();
for (const a of [...fe, ...be]) {
  for (const p of a.routePrefixes) {
    if (seen.has(p) && seen.get(p) !== a.id) errors.push(`prefix ${p} claimed by both ${seen.get(p)} and ${a.id}`);
    seen.set(p, a.id);
  }
}

if (errors.length) {
  console.error("module registry parity check FAILED:");
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
console.log(`module registry parity OK (${fe.length} modules, prefixes unique)`);
