// VLT-GAP-15 suite: runs the whole old-vs-new replay once; 15-B records it, 15-C judges it.
import fs from "node:fs";
import path from "node:path";
import { ROOT, sha256 } from "./gap-common.mjs";
import { runRoutes, runHealthModules, runPurgePair, PURGE_PAIRS, runBlobPair, SCENARIOS, HEALTH_SCENARIOS, freezeWorld, stable, firstDiff } from "./equivalence-replay.mjs";

export const GAPDIR = path.join(ROOT, "scripts/antas/vault/gap");
export const cfg = JSON.parse(fs.readFileSync(path.join(GAPDIR, "gap-configs/vault-equivalence.json"), "utf8"));
export const rcfg = JSON.parse(fs.readFileSync(path.join(GAPDIR, "gap-configs/vault-equivalence-replay.json"), "utf8"));
const ROUTE_RE = /\brouter\.(get|post|put|patch|delete)\(/;
const GAPRE = /(is not a function|is not defined|is not iterable|Cannot destructure|Cannot read properties of undefined)/;
export const DIM_LABEL = {
  db_state: /^(db\.|pool\.|client\.)/,
  encrypted_values: /^(?:call:)?(decrypt|encrypt)/i,
  events: /^(?:call:)?(broadcastEvent|publishEvent|emitEvent|publishAyzenDomainEvent)/,
  audit: /^(?:call:)?(recordAudit|logActivity|logVaultActivity|logSubjectActivity|logBackupAudit|auditVault)/,
  side_effects: /^(?:call:)?(createNotification|syncOnVaultDelete|delistVaultMarketplaceListings|chargeCredits|sendMail|sendToUser|sendEmail|sendVault)/,
};
export const dimOf = (label) => Object.entries(DIM_LABEL).filter(([, re]) => re.test(label)).map(([d]) => d);

export function groupInputs(g, gc) {
  const texts = {}, oldFiles = [];
  for (const b of gc.baseline) { const t = fs.readFileSync(path.join(ROOT, b), "utf8"); if (ROUTE_RE.test(t)) { const f = `routes/__old__${path.basename(b)}.ts`; texts[f] = t; oldFiles.push(f); } }
  const newFiles = gc.current_files.filter((f) => ROUTE_RE.test(fs.readFileSync(path.join(ROOT, cfg.src_root, f), "utf8")));
  const bind = Object.fromEntries(Object.entries(rcfg.old_module_bindings?.[g] ?? {}).map(([k, v]) => [k, oldFiles.find((f) => f.endsWith(`__${v}.ts`))]));
  const baselineText = gc.baseline.map((b) => fs.readFileSync(path.join(ROOT, b), "utf8")).join("\n");
  return { texts, oldFiles, newFiles, bind, baselineText };
}

// returns { groups: { g: { kind, cells:[{route,scn,old,new,equal,diff}], loadErrors, ... } } }
export async function runSuite() {
  freezeWorld();
  const groups = {};
  for (const [g, gc] of Object.entries(cfg.groups)) {
    const inp = groupInputs(g, gc);
    const rec = { kind: inp.oldFiles.length ? "routes" : "module", cells: [], loadErrors: [], old_routes: [], new_routes: [], baselineText: inp.baselineText };
    if (inp.oldFiles.length) {
      for (const scn of SCENARIOS) {
        const o = await runRoutes({ files: inp.oldFiles, texts: inp.texts, scn, bind: inp.bind });
        const n = await runRoutes({ files: inp.newFiles, scn });
        const n2 = await runRoutes({ files: inp.newFiles, scn }); // determinism probe
        rec.loadErrors.push(...o.loadErrors.map((e) => `old ${e}`), ...n.loadErrors.map((e) => `new ${e}`));
        for (const k of Object.keys(o.routes)) {
          if (!rec.old_routes.includes(k)) rec.old_routes.push(k);
          const a = o.routes[k], b = n.routes[k] ?? null;
          rec.cells.push({ route: k, scn: scn.id, old: a, new: b, deterministic: stable(n.routes[k]) === stable(n2.routes[k]), equal: b !== null && stable(a) === stable(b), diff: b ? firstDiff(a, b) : "route missing in current code" });
        }
        for (const k of Object.keys(n.routes)) if (!rec.new_routes.includes(k)) rec.new_routes.push(k);
      }
    } else if (g === "health") {
      const B = (n) => fs.readFileSync(path.join(ROOT, gc.baseline.find((b) => b.endsWith(n))), "utf8");
      const t = { oldScanText: B("lib__vault__health__scan__ts"), oldCronText: B("lib__vault__health__cron__ts"), oldRoutesVaultText: fs.readFileSync(path.join(ROOT, "reports/antas/vault/gap/VLT-GAP-11/baseline/sources/artifacts__api__server__src__routes__vault__ts"), "utf8") };
      for (const scn of HEALTH_SCENARIOS) {
        const r = await runHealthModules({ ...t, scn }); const r2 = await runHealthModules({ ...t, scn });
        for (const k of Object.keys(r.old)) rec.cells.push({ route: `health:${k}`, scn: scn.id, old: r.old[k], new: r.new[k], deterministic: stable(r.new[k]) === stable(r2.new[k]), equal: stable(r.old[k]) === stable(r.new[k]), diff: firstDiff(r.old[k], r.new[k]) });
      }
    }
    if (g === "snapshot-trash") {
      for (const pair of PURGE_PAIRS) for (const scn of SCENARIOS.filter((x) => ["empty-db", "row-db", "row-db-two-rows", "db-throws"].includes(x.id))) {
        const r = await runPurgePair(pair, scn), r2 = await runPurgePair(pair, scn);
        rec.cells.push({ route: `module:${pair.name}`, scn: scn.id, old: r.old, new: r.new, deterministic: stable(r.new) === stable(r2.new), equal: stable(r.old) === stable(r.new), diff: firstDiff(r.old, r.new) });
      }
    }
    if (g === "snapshot-trash") {
      const b = await runBlobPair(), b2 = await runBlobPair();
      const tag = (arr) => ({ result: arr, log: arr.filter(([k]) => /^(enc|dec)/.test(k)).map(([k]) => [k.startsWith("enc") ? "call:encryptBlob" : "call:decryptBlob", k]) });
      rec.cells.push({ route: "module:snapshot-blob-crypto", scn: "real-node-crypto", old: tag(b.old), new: tag(b.new), deterministic: stable(b.new) === stable(b2.new), equal: stable(b.old) === stable(b.new), diff: firstDiff(b.old, b.new) });
    }
    groups[g] = rec;
  }
  return groups;
}

export function logsOf(cell) {
  const o = cell.old ?? {}; const out = [...(o.log ?? [])];
  for (const v of Object.values(o)) if (v && typeof v === "object" && Array.isArray(v.log)) out.push(...v.log);
  return out;
}
export function depthOf(cell) {
  const o = cell.old ?? {};
  const txt = JSON.stringify(o.body ?? "") + (o.threw ?? "");
  if (o.status !== undefined) return { responded: o.status !== null && o.status < 500 && !o.threw && !GAPRE.test(txt) };
  return { responded: !o.threw };
}
export function digest(cell) { return sha256(stable({ o: cell.old, n: cell.new })).slice(0, 16); }
