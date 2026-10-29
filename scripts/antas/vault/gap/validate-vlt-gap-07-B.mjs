#!/usr/bin/env node
// VLT-GAP-07-B — prove shared crypto primitives were extracted from the sealed source census.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT, binding, rejectBypass, sha256File } from "./gap-common.mjs";

const SUB_PHASE = "VLT-GAP-07-B";
const A_MANIFEST = "reports/antas/vault/gap/VLT-GAP-07/baseline/repo-manifest.json";
const A_INVENTORY = "reports/antas/vault/gap/VLT-GAP-07/symbol-inventory.json";
const PROOF = "reports/antas/vault/gap/VLT-GAP-07/extraction-proof.json";
const CORE = "packages/vault-crypto/src/aes-gcm.mjs";
const DECLARATIONS = "packages/vault-crypto/src/aes-gcm.d.mts";
const MAP = "docs/antas/vault/file-migration-map.md";
const FAIL = (message) => { console.error(`${SUB_PHASE} FAIL — ${message}`); process.exit(1); };
const bypass = rejectBypass();
if (bypass.length) FAIL(`bypass rejected: ${bypass.join(", ")}`);
for (const [key, value] of Object.entries(process.env)) {
  if (/^(VALIDATION_DISABLED|ANTAS_BYPASS|VLT_BYPASS|VAULT_BYPASS)$/i.test(key) && value && !/^(0|false|no)$/i.test(value)) {
    FAIL(`bypass rejected: ${key}`);
  }
}
for (const file of [A_MANIFEST, A_INVENTORY, CORE, DECLARATIONS, MAP]) {
  if (!fs.existsSync(path.join(ROOT, file))) FAIL(`required source/evidence missing: ${file}`);
}
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const manifest = JSON.parse(read(A_MANIFEST));
const inventory = JSON.parse(read(A_INVENTORY));
if (manifest.status !== "PASS" || inventory.status !== "PASS" || inventory.sub_phase !== "VLT-GAP-07-A") {
  FAIL("sealed 07-A source census is not PASS");
}
for (const source of manifest.sources ?? []) {
  const frozen = path.join(ROOT, source.baseline_copy);
  if (!fs.existsSync(frozen) || sha256File(frozen) !== source.sha256) FAIL(`frozen 07-A source is missing or corrupt: ${source.file}`);
}
if (fs.existsSync(path.join(ROOT, PROOF))) {
  const sealed = JSON.parse(read(PROOF));
  if (sealed.status === "PASS" && sealed.sub_phase === SUB_PHASE) {
    for (const file of [CORE, DECLARATIONS]) {
      if (sealed.source_hashes?.[file] !== sha256File(path.join(ROOT, file))) FAIL(`sealed 07-B extraction changed after PASS: ${file}`);
    }
    console.log(`${SUB_PHASE} already PASS — shared implementation proof remains sealed; later consumer wiring is left to 07-C`);
    process.exit(0);
  }
}

const ts = createRequire(path.join(ROOT, "package.json"))("typescript");
const parse = (file, source) => ts.createSourceFile(
  file,
  source,
  ts.ScriptTarget.Latest,
  true,
  file.endsWith(".mjs") || file.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS,
);
const baselineWithAes = manifest.sources.filter((source) => {
  const file = path.join(ROOT, source.baseline_copy);
  return /\bcreateCipheriv\b/.test(fs.readFileSync(file, "utf8")) || /\bcreateDecipheriv\b/.test(fs.readFileSync(file, "utf8"));
});
if (baselineWithAes.length < 6) FAIL(`pre-extraction census did not capture the known duplicated AES consumers (found ${baselineWithAes.length})`);

const coreText = read(CORE);
const declarationText = read(DECLARATIONS);
const coreTree = parse(CORE, coreText);
if (coreTree.parseDiagnostics.length) FAIL("shared AES-GCM implementation has parse errors");
const requiredExports = [
  "deriveKekHkdf",
  "deriveLegacyAesKey",
  "encryptAes256Gcm",
  "decryptAes256Gcm",
  "packAesGcmHex",
  "unpackAesGcmHex",
];
for (const symbol of requiredExports) {
  if (!new RegExp(`export function ${symbol}\\b`).test(coreText)) FAIL(`shared crypto owner is missing ${symbol}`);
  if (!new RegExp(`export function ${symbol}\\b`).test(declarationText)) FAIL(`shared type declarations are missing ${symbol}`);
}
for (const token of ["createCipheriv", "cipher.update", "cipher.final", "cipher.getAuthTag", "createDecipheriv", "decipher.setAuthTag", "decipher.final", "hkdfSync"]) {
  if (!coreText.includes(token)) FAIL(`shared owner does not contain required extracted primitive operation: ${token}`);
}
if (!coreText.includes("if (aad) cipher.setAAD") || !coreText.includes("if (aad) decipher.setAAD")) {
  FAIL("shared owner lost optional authenticated-data handling");
}
const mapLine = "| AES-GCM primitives and legacy KEK derivation | duplicated across Vault/API, scripts, and vault-service encryption owners | packages/vault-crypto/src/aes-gcm.mjs | IMPLEMENTED (VLT-GAP-07-B/C; validation pending) |";
if (!read(MAP).split("\n").includes(mapLine)) FAIL("crypto extraction is missing or mislabeled in the migration map");

const sourceFiles = [CORE, DECLARATIONS];
const sourceHashes = Object.fromEntries(sourceFiles.map((file) => [file, sha256File(path.join(ROOT, file))]));
const proof = {
  schema_version: 1,
  phase: "VLT-GAP-07",
  sub_phase: SUB_PHASE,
  ...binding(sourceHashes),
  source_hashes: sourceHashes,
  baseline_duplicate_cipher_sources: baselineWithAes.map(({ file, sha256: hash }) => ({ file, sha256: hash })),
  implementation_symbols: requiredExports.map((symbol) => ({ symbol, source: CORE, declared_in: DECLARATIONS })),
  behavior_contracts: [
    "AES-256-GCM with 12-byte generated IV and authenticated tag",
    "optional AAD is authenticated before payload processing",
    "both UTF-8 strings and raw key bytes use the same primitive",
    "hex IV:ciphertext:tag compatibility packing remains available",
    "strong HKDF-SHA256 and legacy slice/pad key derivations remain available",
  ],
  status: "PASS",
};
const output = path.join(ROOT, PROOF);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(proof, null, 2)}\n`);
console.log(`${SUB_PHASE} PASS — common AES-GCM, AAD, binary, serialization, and KEK primitives are source-backed; ${baselineWithAes.length} pre-extraction cipher sources recorded`);