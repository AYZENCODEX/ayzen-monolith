#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { ROOT, rel, walkFiles } from "./gap-common.mjs";

const vaultRoot = path.join(ROOT, "artifacts/api-server/src/vault");
const mapPath = path.join(ROOT, "docs/antas/vault/file-migration-map.md");
const outputPath = path.join(ROOT, "docs/antas/vault/gap-register.md");
const vaultPrefix = "artifacts/api-server/src/vault/";

const rank = { OPEN: 0, PARTIAL: 1, PROVEN: 2, BARREL: 3, UNMAPPED: 4 };
const rows = new Map();
const tableLines = fs.readFileSync(mapPath, "utf8").split(/\r?\n/);

for (const line of tableLines) {
  if (!line.startsWith("|")) continue;
  const cells = line.split("|").map((cell) => cell.trim());
  if (cells.length < 5) continue;
  const source = cells[2];
  const targets = [...cells[3].matchAll(/(artifacts\/api-server\/src\/vault\/[^`\s,|]+\.(?:ts|tsx))/g)].map((m) => m[1]);
  const status = cells[4];
  let classification = "UNMAPPED";
  if (/UNCERTIFIED|PENDING|ORIGIN-UNPROVEN/i.test(status)) classification = "OPEN";
  else if (/BARREL|PUBLIC-REEXPORT|barrel\s*[—-]\s*re-exports only/i.test(status)) classification = "BARREL";
  else if (/NEW-SEAM|compatibility-preserved|\bSEAM\b/i.test(status)) classification = "PARTIAL";
  else if (/EXTRACTED|RETIRED|thin entrypoint|^extracted\b/i.test(status)) classification = "PROVEN";
  for (const target of targets) {
    const prior = rows.get(target);
    const candidate = { source: source || "n/a", classification, evidence: status.replace(/\s+/g, " ").trim() };
    if (!prior || rank[classification] < rank[prior.classification]) rows.set(target, candidate);
  }
}

const files = walkFiles(vaultRoot).filter((file) => /\.(?:ts|tsx)$/.test(file)).map(rel).sort();
const register = files.map((file) => ({
  file,
  ...(rows.get(file) ?? { source: "n/a", classification: "UNMAPPED", evidence: "No migration-map row targets this source file." }),
}));
const counts = Object.fromEntries(["PROVEN", "PARTIAL", "BARREL", "OPEN", "UNMAPPED"].map((key) => [key, register.filter((row) => row.classification === key).length]));
const lines = [
  "# Vault GAP-00 Source Register",
  "",
  "Generated from the current Vault source tree and the authoritative per-file migration map. `PROVEN` means the row carries extracted/retired certification; `PARTIAL` records a documented shared or newly introduced seam; `BARREL` is an intentional public re-export; `OPEN` or `UNMAPPED` requires follow-up.",
  "",
  `**Current inventory:** ${files.length} Vault TypeScript files — ${counts.PROVEN} proven, ${counts.PARTIAL} partial seams, ${counts.BARREL} public barrels, ${counts.OPEN} open, ${counts.UNMAPPED} unmapped.`,
  "",
  "| Vault source file | GAP-00 status | Origin/source boundary | Evidence or reason |",
  "| --- | --- | --- | --- |",
  ...register.map((row) => `| \`${row.file}\` | ${row.classification} | ${row.source.replaceAll("|", "\\|")} | ${row.evidence.replaceAll("|", "\\|")} |`),
  "",
];

fs.writeFileSync(outputPath, lines.join("\n"));
console.log(`VLT-GAP-00 generated ${files.length} rows — ${counts.PROVEN} proven, ${counts.PARTIAL} partial, ${counts.BARREL} barrels, ${counts.OPEN} open, ${counts.UNMAPPED} unmapped.`);
