#!/usr/bin/env node
/**
 * scripts/src/check-module-registry.mjs
 *
 * W0-P3: validates the single module registry (packages/module-registry) and that nothing
 * re-declares it. History: Module Shell Split S1 compared two hand-synced copies with regexes
 * that only understood single-segment prefixes, so every "/admin/<x>" prefix was invisible to
 * the check (and a real double-claim of /admin/team-vault by warde went unnoticed). This version
 * imports the registry and checks it directly. Blocking in CI (see .github/workflows/ci.yml).
 *
 *   node scripts/src/check-module-registry.mjs
 *   node scripts/src/check-module-registry.mjs --self-test
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

/** Pure registry checks; returns an array of error strings. */
export function checkRegistry(modules) {
  const errors = [];
  const uniq = (key) => {
    const seen = new Map();
    for (const m of modules) {
      const v = m[key];
      if (seen.has(v)) errors.push(`${key} "${v}" used by both ${seen.get(v)} and ${m.id}`);
      seen.set(v, m.id);
    }
  };
  for (const key of ["id", "label", "uidPrefix", "hostEnv", "defaultHost", "order", "telegramBot", "oidcClientId"]) uniq(key);

  for (const m of modules) {
    if (!/^[a-z]+$/.test(m.id)) errors.push(`${m.id}: id must be lowercase letters`);
    if (!/^[A-Z]{3}$/.test(m.uidPrefix ?? "")) errors.push(`${m.id}: uidPrefix must be 3 uppercase letters (ADR A1)`);
    if (!/^[a-z0-9-]+\.ayzen\.tech$/.test(m.defaultHost ?? "")) errors.push(`${m.id}: defaultHost must be <label>.ayzen.tech`);
    if (m.hostEnv !== `${m.id.toUpperCase()}_HOSTS`) errors.push(`${m.id}: hostEnv must be ${m.id.toUpperCase()}_HOSTS`);
    if (!m.routePrefixes?.length) errors.push(`${m.id}: needs at least one routePrefix`);
    for (const p of m.routePrefixes ?? []) {
      if (!/^\/[a-zA-Z0-9_-]+(\/[a-zA-Z0-9_-]+)*$/.test(p)) errors.push(`${m.id}: malformed routePrefix "${p}"`);
    }
    if (!(m.routePrefixes ?? []).some((p) => m.homePath === p || m.homePath.startsWith(p + "/"))) {
      errors.push(`${m.id}: homePath ${m.homePath} is outside its own routePrefixes`);
    }
  }

  // Exact duplicates AND nesting (e.g. "/admin" vs "/admin/vault" owned by different modules).
  const claims = modules.flatMap((m) => (m.routePrefixes ?? []).map((p) => ({ id: m.id, p })));
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i], b = claims[j];
      if (a.id === b.id) continue;
      if (a.p === b.p) errors.push(`prefix ${a.p} claimed by both ${a.id} and ${b.id}`);
      else if (b.p.startsWith(a.p + "/") || a.p.startsWith(b.p + "/")) {
        errors.push(`prefix ${a.p} (${a.id}) overlaps ${b.p} (${b.id})`);
      }
    }
  }
  return errors;
}

function selfTest() {
  const base = {
    id: "aaa", label: "A", uidPrefix: "AAA", order: 1, hostEnv: "AAA_HOSTS", defaultHost: "aaa.ayzen.tech",
    telegramBot: "aaa", oidcClientId: "aaa", homePath: "/a", routePrefixes: ["/a", "/admin/a"],
  };
  const other = { ...base, id: "bbb", label: "B", uidPrefix: "BBB", order: 2, hostEnv: "BBB_HOSTS", defaultHost: "bbb.ayzen.tech", telegramBot: "bbb", oidcClientId: "bbb", homePath: "/b", routePrefixes: ["/b"] };
  const cases = [
    ["clean registry passes", [base, other], 0],
    ["duplicate admin prefix is caught", [base, { ...other, routePrefixes: ["/b", "/admin/a"] }], 1],
    ["nested prefix across modules is caught", [base, { ...other, routePrefixes: ["/b", "/admin/a/deep"] }], 1],
    ["duplicate uidPrefix is caught", [base, { ...other, uidPrefix: "AAA" }], 1],
    ["homePath outside prefixes is caught", [base, { ...other, homePath: "/zzz" }], 1],
  ];
  let bad = 0;
  for (const [name, mods, want] of cases) {
    const got = checkRegistry(mods).length;
    const ok = want === 0 ? got === 0 : got >= want;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
    if (!ok) bad++;
  }
  process.exit(bad ? 1 : 0);
}

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();

  const { MODULES } = await import(pathToFileURL(join(root, "packages/module-registry/src/index.mjs")).href);
  const errors = checkRegistry(MODULES);
  const ids = MODULES.map((m) => m.id).sort();

  // Consumers must derive from the registry, not re-declare it.
  const backend = read("artifacts/api-server/src/lib/shared-apps.ts");
  const frontend = read("artifacts/ayzen/src/lib/subdomain-app.ts");
  for (const [file, src] of [["artifacts/api-server/src/lib/shared-apps.ts", backend], ["artifacts/ayzen/src/lib/subdomain-app.ts", frontend]]) {
    if (!src.includes('"@ayzen/module-registry"')) errors.push(`${file}: must import @ayzen/module-registry`);
    if (/\bhomePath:\s*"\//.test(src) || /\broutePrefixes:\s*\[\s*"\//.test(src)) {
      errors.push(`${file}: re-declares homePath/routePrefixes literals; edit packages/module-registry instead`);
    }
  }

  // Other id-keyed registries must cover exactly the same modules.
  const seedIds = [...read("scripts/src/seed-oidc-clients.ts").matchAll(/seedClient\("([a-z]+)"/g)].map((m) => m[1]).sort();
  if (JSON.stringify(seedIds) !== JSON.stringify(ids)) {
    errors.push(`scripts/src/seed-oidc-clients.ts seedClient ids [${seedIds}] != registry [${ids}]`);
  }
  // Parsed from source (not imported) so this check needs no `pnpm install` in CI.
  const tgSrc = read("packages/telegram/src/index.mjs");
  const botBlock = tgSrc.slice(tgSrc.indexOf("BOT_REGISTRY = Object.freeze({"), tgSrc.indexOf("APP_NAMES"));
  const botKeys = new Set([...botBlock.matchAll(/^  ([a-z]+): \{/gm)].map((m) => m[1]));
  for (const m of MODULES) {
    if (!botKeys.has(m.telegramBot)) errors.push(`${m.id}: telegramBot "${m.telegramBot}" missing from packages/telegram BOT_REGISTRY`);
  }

  if (errors.length) {
    console.error("module registry check FAILED:");
    for (const e of errors) console.error("  - " + e);
    process.exit(1);
  }
  const prefixCount = MODULES.reduce((n, m) => n + m.routePrefixes.length, 0);
  console.log(`module registry OK (${MODULES.length} modules, ${prefixCount} unique non-overlapping prefixes, consumers derive from registry)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
