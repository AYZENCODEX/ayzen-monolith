#!/usr/bin/env node
// VLT-GAP-07-D — retire: no inline AES-GCM / HKDF implementation may remain anywhere outside the shared crypto owner.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { ROOT, binding, rejectBypass, rel, sha256File, walkFiles } from "./gap-common.mjs";

const SUB_PHASE = "VLT-GAP-07-D";
const DIR = "reports/antas/vault/gap/VLT-GAP-07";
const A_MANIFEST = `${DIR}/baseline/repo-manifest.json`;
const A_INVENTORY = `${DIR}/symbol-inventory.json`;
const B_PROOF = `${DIR}/extraction-proof.json`;
const C_EVIDENCE = `${DIR}/consumer-graph.json`;
const EVIDENCE = `${DIR}/retire-proof.json`;
const CORE = "packages/vault-crypto/src/aes-gcm.mjs";
const DECLARATIONS = "packages/vault-crypto/src/aes-gcm.d.mts";
const TEST = "packages/vault-crypto/src/aes-gcm.test.mjs";
const MAP = "docs/antas/vault/file-migration-map.md";
// Every file that performs AES-GCM or KEK derivation must reach the owner through exactly one import.
const CONSUMERS = [
  "artifacts/api-server/src/vault/crypto/field-encryption.ts",
  "artifacts/api-server/src/vault/crypto/seed-phrase.ts",
  "artifacts/api-server/src/lib/wallet-crypto.ts",
  "artifacts/api-server/src/vault/crypto/backup-envelope.ts",
  "artifacts/api-server/src/routes/vault-snapshot.ts",
  "scripts/src/reencrypt-vault.ts",
  "scripts/src/reencrypt-seed-phrases.ts",
  "scripts/src/rewrap-encryption-keys.ts",
  "scripts/src/encrypt-env.ts",
  "scripts/src/decrypt-env.ts",
  "services/vault/src/crypto/envelope.mjs",
];
const INLINE = /\b(?:createCipheriv|createDecipheriv|createCipher|createDecipher|hkdfSync|hkdf)\b/;
const CODE_EXT = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const EXEMPT = new Set([CORE, TEST, DECLARATIONS]);
const MAP_ROW = "| AES-GCM primitives and legacy KEK derivation | duplicated across Vault/API, scripts, and vault-service encryption owners | packages/vault-crypto/src/aes-gcm.mjs | RETIRED (VLT-GAP-07-D) |";
const OLD_MAP_ROW = "| AES-GCM primitives and legacy KEK derivation | duplicated across Vault/API, scripts, and vault-service encryption owners | packages/vault-crypto/src/aes-gcm.mjs | IMPLEMENTED (VLT-GAP-07-B/C; validation pending) |";

const fail = (message) => { console.error(`${SUB_PHASE} FAIL — ${message}`); process.exit(1); };
const bypass = rejectBypass();
if (bypass.length) fail(`bypass rejected: ${bypass.join(", ")}`);
for (const [key, value] of Object.entries(process.env)) {
  if (/^(VALIDATION_DISABLED|ANTAS_BYPASS|VLT_BYPASS|VAULT_BYPASS)$/i.test(key) && value && !/^(0|false|no)$/i.test(value)) fail(`bypass rejected: ${key}`);
}
const abs = (file) => path.join(ROOT, file);
const read = (file) => fs.readFileSync(abs(file), "utf8");
for (const file of [A_MANIFEST, A_INVENTORY, B_PROOF, C_EVIDENCE, CORE, DECLARATIONS, TEST, MAP, ...CONSUMERS]) {
  if (!fs.existsSync(abs(file))) fail(`required source/evidence missing: ${file}`);
}

// 1. Earlier gates must be validator-written PASS and still describe the current owner.
const a = JSON.parse(read(A_MANIFEST));
const inv = JSON.parse(read(A_INVENTORY));
const b = JSON.parse(read(B_PROOF));
const c = JSON.parse(read(C_EVIDENCE));
if (a.status !== "PASS" || inv.status !== "PASS" || inv.sub_phase !== "VLT-GAP-07-A") fail("07-A census is not PASS");
if (b.status !== "PASS" || b.sub_phase !== "VLT-GAP-07-B") fail("07-B extraction proof is not PASS");
if (c.status !== "PASS" || c.sub_phase !== "VLT-GAP-07-C") fail("07-C consumer proof is not PASS");
for (const source of a.sources ?? []) {
  const frozen = abs(source.baseline_copy);
  if (!fs.existsSync(frozen) || sha256File(frozen) !== source.sha256) fail(`frozen 07-A baseline missing or corrupt: ${source.file}`);
}
for (const file of [CORE, DECLARATIONS]) {
  if (b.source_hashes?.[file] !== sha256File(abs(file))) fail(`shared owner changed after sealed 07-B proof: ${file}`);
}

// 2. Repo-wide: no inline implementation outside the owner (comments/strings ignored via the TS scanner).
const ts = createRequire(path.join(ROOT, "package.json"))("typescript");
const codeTokens = (file, text) => {
  const kind = /\.(?:mjs|cjs|js)$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TSX;
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const found = [];
  const visit = (node) => {
    if (ts.isIdentifier(node) && INLINE.test(node.text)) found.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
};
const violations = [];
const scanned = walkFiles(ROOT, [], (p) => CODE_EXT.test(p) && !rel(p).startsWith("scripts/antas/") && !EXEMPT.has(rel(p)));
for (const p of scanned) {
  const file = rel(p);
  const text = fs.readFileSync(p, "utf8");
  if (!INLINE.test(text)) continue;
  const hits = codeTokens(file, text);
  if (hits.length) violations.push({ file, symbols: [...new Set(hits)] });
}
if (violations.length) fail(`inline AES/KEK implementation remains outside the shared owner:\n${violations.map((v) => `  ${v.file}: ${v.symbols.join(", ")}`).join("\n")}`);

// 3. Every consumer imports the owner exactly once, resolving to the real file.
const consumers = [];
for (const file of CONSUMERS) {
  const tree = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, file.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  if (tree.parseDiagnostics.length) fail(`parse error in ${file}`);
  const imports = tree.statements.filter(ts.isImportDeclaration).filter((n) => n.moduleSpecifier.text.endsWith("/packages/vault-crypto/src/aes-gcm.mjs"));
  if (imports.length !== 1) fail(`${file} must import the shared AES-GCM owner exactly once`);
  const spec = imports[0].moduleSpecifier.text;
  if (path.resolve(path.dirname(abs(file)), spec) !== abs(CORE)) fail(`${file} import does not resolve to the shared owner`);
  consumers.push({ file, import: spec });
}

// 4. Owner is real code, tests pass.
const coreTree = ts.createSourceFile(CORE, read(CORE), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const exported = coreTree.statements.filter((n) => ts.isFunctionDeclaration(n) && n.body && n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)).map((n) => n.name.text);
for (const s of ["deriveKekHkdf", "deriveLegacyAesKey", "encryptAes256Gcm", "decryptAes256Gcm", "packAesGcmHex", "unpackAesGcmHex"]) {
  if (!exported.includes(s)) fail(`shared owner lost export ${s}`);
}
const tests = spawnSync("node", ["--test", TEST], { cwd: ROOT, encoding: "utf8", timeout: 180_000 });
if (tests.error || tests.status !== 0) { console.error(`${tests.stdout}${tests.stderr}`.slice(-8000)); fail(`shared crypto tests failed (exit ${tests.status ?? "unknown"})`); }

// 5. Migration map (the only edit the validator makes outside its evidence file).
let map = read(MAP);
if (map.split("\n").includes(OLD_MAP_ROW)) { map = map.replace(OLD_MAP_ROW, MAP_ROW); fs.writeFileSync(abs(MAP), map); }
if (!map.split("\n").includes(MAP_ROW)) fail("migration map row for the shared crypto owner is missing or not RETIRED");

const sourceHashes = Object.fromEntries([CORE, DECLARATIONS, TEST, ...CONSUMERS].map((f) => [f, sha256File(abs(f))]));
const evidence = {
  schema_version: 1,
  phase: "VLT-GAP-07",
  sub_phase: SUB_PHASE,
  ...binding(sourceHashes),
  source_hashes: sourceHashes,
  files_scanned: scanned.length,
  inline_implementations_remaining: [],
  consumers,
  tests: { command: `node --test ${TEST}`, exit_code: tests.status },
  status: "PASS",
};
fs.mkdirSync(path.dirname(abs(EVIDENCE)), { recursive: true });
fs.writeFileSync(abs(EVIDENCE), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`${SUB_PHASE} PASS — ${scanned.length} source files scanned, no inline AES-GCM/HKDF outside ${CORE}; ${consumers.length} consumers use the owner`);
