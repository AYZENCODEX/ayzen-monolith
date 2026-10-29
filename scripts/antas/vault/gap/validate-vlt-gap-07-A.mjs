#!/usr/bin/env node
// VLT-GAP-07-A — freeze the pre-extraction crypto/key-rotation source census.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ROOT, binding, rejectBypass, rel, sha256, sha256File } from "./gap-common.mjs";

const SUB_PHASE = "VLT-GAP-07-A";
const BASELINE_DIR = "reports/antas/vault/gap/VLT-GAP-07/baseline";
const MANIFEST = `${BASELINE_DIR}/repo-manifest.json`;
const INVENTORY = "reports/antas/vault/gap/VLT-GAP-07/symbol-inventory.json";
const SELF = rel(fileURLToPath(import.meta.url));
const SOURCES = [
  "artifacts/api-server/src/vault/crypto/field-encryption.ts",
  "artifacts/api-server/src/vault/crypto/seed-phrase.ts",
  "artifacts/api-server/src/lib/wallet-crypto.ts",
  "artifacts/api-server/src/lib/vault-backup-envelope.ts",
  "scripts/src/reencrypt-vault.ts",
  "scripts/src/reencrypt-seed-phrases.ts",
  "scripts/src/rewrap-encryption-keys.ts",
  "services/vault/src/crypto/envelope.mjs",
];
const fail = (message) => { console.error(`${SUB_PHASE} FAIL — ${message}`); process.exit(1); };
const bypass = rejectBypass();
if (bypass.length) fail(`bypass rejected: ${bypass.join(", ")}`);
for (const [key, value] of Object.entries(process.env)) {
  if (/^(VALIDATION_DISABLED|ANTAS_BYPASS|VLT_BYPASS|VAULT_BYPASS)$/i.test(key) && value && !/^(0|false|no)$/i.test(value)) {
    fail(`bypass rejected: ${key}`);
  }
}

const manifestPath = path.join(ROOT, MANIFEST);
const inventoryPath = path.join(ROOT, INVENTORY);
if (fs.existsSync(manifestPath) || fs.existsSync(inventoryPath)) {
  if (!fs.existsSync(manifestPath) || !fs.existsSync(inventoryPath)) fail("partial 07-A evidence exists; refusing to replace a sealed snapshot");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
  if (manifest.status !== "PASS" || inventory.status !== "PASS" || inventory.sub_phase !== SUB_PHASE) fail("existing 07-A evidence is not a sealed PASS");
  if (manifest.validator_sha256 !== sha256File(path.join(ROOT, SELF))) fail("sealed 07-A validator changed after PASS");
  for (const source of manifest.sources ?? []) {
    const frozen = path.join(ROOT, source.baseline_copy);
    if (!fs.existsSync(frozen) || sha256File(frozen) !== source.sha256) fail(`sealed baseline is missing or corrupt: ${source.file}`);
  }
  console.log(`${SUB_PHASE} already PASS — sealed pre-extraction census and source copies retained without recensus`);
  process.exit(0);
}

const ts = createRequire(path.join(ROOT, "package.json"))("typescript");
const captureFromHead = (file) => {
  const result = spawnSync("git", ["show", `HEAD:${file}`], { cwd: ROOT, encoding: "buffer", maxBuffer: 20 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail(`cannot recover pre-extraction source from git HEAD: ${file}`);
  return result.stdout;
};
const fileToken = (file) => file.replace(/[^a-zA-Z0-9]+/g, "__").replace(/^__|__$/g, "");
const parse = (file, source) => ts.createSourceFile(
  file,
  source.toString("utf8"),
  ts.ScriptTarget.Latest,
  true,
  file.endsWith(".mjs") || file.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS,
);
const sources = [];
const records = [];
const frozenBuffers = new Map();
for (const file of SOURCES) {
  // VLT-GAP-08 moved lib/vault-backup-envelope.ts; its pre-extraction bytes still come from git HEAD below.
  const movedByGap08 = { "artifacts/api-server/src/lib/vault-backup-envelope.ts": "artifacts/api-server/src/vault/crypto/backup-envelope.ts" };
  if (!fs.existsSync(path.join(ROOT, file)) && !(movedByGap08[file] && fs.existsSync(path.join(ROOT, movedByGap08[file])))) fail(`required source missing: ${file}`);
  const bytes = captureFromHead(file);
  const baselineCopy = `${BASELINE_DIR}/sources/${fileToken(file)}`;
  frozenBuffers.set(baselineCopy, bytes);
  const tree = parse(file, bytes);
  if (tree.parseDiagnostics.length) fail(`pre-extraction source does not parse: ${file}`);
  const firstRecord = records.length;
  const add = (name, kind, node) => {
    const bodyHash = node.body ? sha256(node.body.getText(tree)) : null;
    const record = { file, name, kind, body_sha256: bodyHash };
    records.push(record);
    declarations.push(record);
  };
  for (const node of tree.statements) {
    if (ts.isFunctionDeclaration(node) && node.name) add(node.name.text, "function", node);
    else if (ts.isClassDeclaration(node) && node.name) add(node.name.text, "class", node);
    else if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer &&
            (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
          records.push({ file, name: declaration.name.text, kind: "function-value", body_sha256: sha256(declaration.initializer.body.getText(tree)) });
        }
      }
    }
  }
  sources.push({
    file,
    baseline_copy: baselineCopy,
    sha256: sha256(bytes),
    bytes: bytes.length,
    declaration_count: records.length - firstRecord,
  });
}

const sourceHashes = Object.fromEntries(sources.map((source) => [source.file, source.sha256]));
const bindingInfo = binding(sourceHashes);
const manifest = {
  schema_version: 1,
  phase: "VLT-GAP-07",
  sub_phase: SUB_PHASE,
  validator_sha256: sha256File(path.join(ROOT, SELF)),
  ...bindingInfo,
  source_hashes: sourceHashes,
  sources,
  status: "PASS",
};
const inventory = {
  schema_version: 1,
  phase: "VLT-GAP-07",
  sub_phase: SUB_PHASE,
  ...binding(sourceHashes),
  source_hashes: sourceHashes,
  sources: sources.map(({ file, declaration_count }) => ({ file, declaration_count })),
  records,
  summary: {
    files: sources.length,
    symbols: records.length,
    aes_primitive_sources: SOURCES.filter((file) => /reencrypt|rewrap|crypto|wallet-crypto/.test(file)).length,
  },
  status: "PASS",
};
const outManifest = path.join(ROOT, MANIFEST);
const outInventory = path.join(ROOT, INVENTORY);
fs.mkdirSync(path.dirname(outManifest), { recursive: true });
for (const [file, bytes] of frozenBuffers) {
  const destination = path.join(ROOT, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes, { flag: "wx" });
}
fs.writeFileSync(outManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
fs.writeFileSync(outInventory, `${JSON.stringify(inventory, null, 2)}\n`, { flag: "wx" });
console.log(`${SUB_PHASE} PASS — froze ${sources.length} pre-extraction sources and censused ${records.length} implementation symbols`);