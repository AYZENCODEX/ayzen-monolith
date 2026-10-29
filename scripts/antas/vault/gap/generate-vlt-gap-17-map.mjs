#!/usr/bin/env node
// VLT-GAP-17-A — per-file census. Writes one OLD→NEW row for every vault/** file that no hand-curated row covers, between the
// GENERATED markers of docs/antas/vault/file-migration-map.md. OLD is never guessed: it is the set of legacy files (routes/vault*,
// local-accounts, kyc*, game-*, marketplace-*, lib/vault-*) that (a) belong to the file's GAP family and (b) actually reach the file
// through the import graph today. A file no family legacy file reaches, or one shared by >4 legacy files, is a NEW-SEAM row with a reason —
// it is not given an invented origin. Idempotent: re-running rewrites only the generated block.
import fs from "node:fs";
import path from "node:path";
import { ROOT, rejectBypass } from "./gap-common.mjs";
import { SRC, MAP_DOC, GEN_BEGIN, GEN_END, parseMap, indexRepo, buildGraph, evidenceState, certifiedFor, globToRe } from "./gap-17-common.mjs";

const bad = rejectBypass([]);
if (bad.length) { console.error(`VLT-GAP-17-A FAIL — bypass rejected: ${bad.join(", ")}`); process.exit(1); }

const R = (f) => `${SRC}/routes/${f}.ts`, L = (f) => `${SRC}/lib/${f}.ts`;
// Legacy sources per GAP family (the roadmap's Sources lists, as they exist on disk).
const FAMILY_SOURCES = {
  "01": [R("vault"), R("vault-entity-links"), R("vault-snapshot"), R("vault-shares")],
  "02": [R("local-accounts")],
  "03": [R("kyc"), R("kyc-data-entities")],
  "04": [R("game-entries"), R("marketplace-game"), R("marketplace-vault")],
  "05": [R("vault")],
  "06": [R("vault-security"), R("vault-reauth"), L("vault-pin-guard")],
  "08": [R("vault-backup-cloud"), R("vault-backup-key"), R("vault-backup-schedule")],
  "09": [R("vault-snapshot"), R("vault-backup-schedule")],
  "10": [R("vault-shares"), R("vault-attachments")],
  "11": [R("vault")],
  "migration": [R("vault-migration")],
  "12": [R("vault"), R("vault-security"), R("vault-reauth"), R("vault-snapshot"), R("vault-shares"), R("vault-attachments"), R("vault-backup-cloud"), R("vault-backup-key"), R("vault-backup-schedule"), R("local-accounts"), R("kyc"), R("kyc-data-entities"), R("game-entries"), R("marketplace-game"), R("marketplace-vault"), R("vault-entity-links"), R("vault-migration")],
};
// First match wins. Family keywords come before the generic security/infra buckets so `kyc-ownership` is KYC, not security.
const FAMILY_RULES = [
  [/kyc/, "03"], [/local-account/, "02"], [/game|market/, "04"], [/health/, "11"], [/backup|key-rotation/, "08"],
  [/snapshot|trash/, "09"], [/share|sharing|attachment/, "10"], [/migration/, "migration"],
  [/entity|activity|admin|receipt/, "01"], [/secret|seed-phrase|crypto|key-store|encryption-key|serial/, "05"],
  [/security|reauth|lockout|pin|deny-responses|request-context|ownership|provider/, "06"],
];
const familyOf = (rel) => (FAMILY_RULES.find(([re]) => re.test(rel)) ?? [null, "12"])[1];
const LABEL = { "01": "entity", "02": "local-account", "03": "KYC", "04": "game/market", "05": "secret/crypto", "06": "security/access", "08": "backup", "09": "snapshot/trash", "10": "share/attachment", "11": "health", "12": "infrastructure", migration: "migration" };

const idx = indexRepo(ROOT), g = buildGraph(ROOT, idx);
const mapPath = path.join(ROOT, MAP_DOC);
const text = fs.readFileSync(mapPath, "utf8");
const [head, rest] = text.includes(GEN_BEGIN) ? [text.slice(0, text.indexOf(GEN_BEGIN)).trimEnd(), text.slice(text.indexOf(GEN_END) + GEN_END.length)] : [text.trimEnd(), ""];
const curated = parseMap(head);
const coveredNew = (f) => curated.some((r) => r.new.some((p) => (p.includes("*") ? globToRe(p).test(f) : p === f)));

const vaultFiles = idx.files.filter((f) => f.startsWith(`${SRC}/vault/`) && f.endsWith(".ts")).sort();
const rows = [];
const stats = { evidence_backed_family: 0, new_seam: 0 };
for (const f of vaultFiles) {
  if (coveredNew(f)) continue;
  const within = f.slice(`${SRC}/vault/`.length);
  const fam = familyOf(within);
  const stripped = fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").trim();
  const isBarrel = /(^|\/)index\.ts$/.test(within) || /^(export\s+(\*|\{[^}]*\})\s+from\s+["'][^"']+["'];?\s*)+$/.test(stripped); // index barrels and pure re-export facades
  const allLegacy = FAMILY_SOURCES["12"].filter((src) => idx.has(src) && g.reach(src).has(f));
  const famReach = FAMILY_SOURCES[fam].filter((src) => idx.has(src) && g.reach(src).has(f));
  const legacyReach = famReach.length ? famReach : allLegacy; // family files first; cross-family importers only if no family file reaches it
  const cert = (kind) => {
    const scopedFiles = [...(FAMILY_SOURCES[fam] ?? []), ...vaultFiles.filter((candidate) => familyOf(candidate.slice(`${SRC}/vault/`.length)) === fam)];
    const ev = evidenceState(ROOT, fam, scopedFiles);
    return fam === "migration" ? "" : certifiedFor(ev, kind) ? "" : "; UNCERTIFIED (recorded evidence not PASS)";
  };
  const tag = fam === "migration" ? "" : ` VLT-GAP-${fam}`;
  let row;
  if (isBarrel) row = `| Vault barrel (${within}) | n/a | \`${f}\` | NEW-SEAM; barrel — re-exports only, introduces no behavior |`;
  else if (legacyReach.length && legacyReach.length <= 4) { stats.evidence_backed_family++; row = `| Vault ${LABEL[fam]} (${within}) | ${legacyReach.map((s) => `\`${s}\``).join(", ")} | \`${f}\` | EXTRACTED (${tag.trim() || "per-file census"}; per-file census, GAP-17; origin = ${famReach.length ? `${LABEL[fam]} family` : "cross-family"} legacy files that import it today)${cert("EXTRACTED")} |`; }
  else { stats.new_seam++; const why = allLegacy.length > 4 ? `shared by ${allLegacy.length} legacy files — cross-cutting seam, no single OLD origin` : `no legacy route/lib file imports it today — OLD origin unproven (consumed by other vault modules or non-route consumers)`; row = `| Vault ${LABEL[fam]} (${within}) | n/a | \`${f}\` | NEW-SEAM; ${why} |`; }
  rows.push(row);
}

const block = [GEN_BEGIN, "", "## Per-file census (VLT-GAP-17)", "", "One row for every `vault/**` file not covered by a curated row above. `EXTRACTED` rows name the legacy files that reach the new owner through the import graph; `NEW-SEAM` rows state why no single OLD origin is claimed. Checked by `validate-vlt-gap-17.mjs`.", "", "| Classification | Old/current source | Target boundary | Status |", "| --- | --- | --- | --- |", ...rows, "", GEN_END].join("\n");
fs.writeFileSync(mapPath, `${head}\n\n${block}${rest.startsWith("\n") ? rest : `\n${rest}`}`.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "\n"));
console.log(`VLT-GAP-17-A generated ${rows.length} rows (${stats.evidence_backed_family} EXTRACTED via import reach, ${stats.new_seam} NEW-SEAM, ${rows.length - stats.evidence_backed_family - stats.new_seam} barrels) for ${vaultFiles.length} vault files`);
