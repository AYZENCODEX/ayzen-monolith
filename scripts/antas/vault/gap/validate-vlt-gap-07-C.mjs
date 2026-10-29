#!/usr/bin/env node
// VLT-GAP-07-C — prove API, operator scripts, and vault-service use the shared crypto owner.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { ROOT, binding, rejectBypass, sha256File } from "./gap-common.mjs";

const SUB_PHASE = "VLT-GAP-07-C";
const A_MANIFEST = "reports/antas/vault/gap/VLT-GAP-07/baseline/repo-manifest.json";
const A_INVENTORY = "reports/antas/vault/gap/VLT-GAP-07/symbol-inventory.json";
const B_PROOF = "reports/antas/vault/gap/VLT-GAP-07/extraction-proof.json";
const EVIDENCE = "reports/antas/vault/gap/VLT-GAP-07/consumer-graph.json";
const CORE = "packages/vault-crypto/src/aes-gcm.mjs";
const TEST = "packages/vault-crypto/src/aes-gcm.test.mjs";
const CONSUMERS = [
  "artifacts/api-server/src/vault/crypto/field-encryption.ts",
  "artifacts/api-server/src/vault/crypto/seed-phrase.ts",
  "artifacts/api-server/src/lib/wallet-crypto.ts",
  "artifacts/api-server/src/vault/crypto/backup-envelope.ts",
  "scripts/src/reencrypt-vault.ts",
  "scripts/src/reencrypt-seed-phrases.ts",
  "scripts/src/rewrap-encryption-keys.ts",
  "services/vault/src/crypto/envelope.mjs",
];
const EXPECTED_IMPORT = "../../packages/vault-crypto/src/aes-gcm.mjs";
const FAIL = (message) => { console.error(`${SUB_PHASE} FAIL — ${message}`); process.exit(1); };
const bypass = rejectBypass();
if (bypass.length) FAIL(`bypass rejected: ${bypass.join(", ")}`);
for (const [key, value] of Object.entries(process.env)) {
  if (/^(VALIDATION_DISABLED|ANTAS_BYPASS|VLT_BYPASS|VAULT_BYPASS)$/i.test(key) && value && !/^(0|false|no)$/i.test(value)) {
    FAIL(`bypass rejected: ${key}`);
  }
}
for (const file of [A_MANIFEST, A_INVENTORY, B_PROOF, CORE, TEST, ...CONSUMERS]) {
  if (!fs.existsSync(path.join(ROOT, file))) FAIL(`required source/evidence missing: ${file}`);
}
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const aManifest = JSON.parse(read(A_MANIFEST));
const aInventory = JSON.parse(read(A_INVENTORY));
const bProof = JSON.parse(read(B_PROOF));
if (aManifest.status !== "PASS" || aInventory.status !== "PASS" || aInventory.sub_phase !== "VLT-GAP-07-A") {
  FAIL("sealed 07-A source census is not PASS");
}
if (bProof.status !== "PASS" || bProof.sub_phase !== "VLT-GAP-07-B") FAIL("07-B extraction proof is not PASS");
if (bProof.source_hashes?.[CORE] !== sha256File(path.join(ROOT, CORE))) FAIL("shared crypto owner changed after the sealed 07-B extraction proof");

const ts = createRequire(path.join(ROOT, "package.json"))("typescript");
const parse = (file, source) => ts.createSourceFile(
  file,
  source,
  ts.ScriptTarget.Latest,
  true,
  file.endsWith(".mjs") || file.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS,
);
const consumers = [];
for (const file of CONSUMERS) {
  const source = read(file);
  const tree = parse(file, source);
  if (tree.parseDiagnostics.length) FAIL(`source parse error in ${file}`);
  const ownerImports = tree.statements
    .filter(ts.isImportDeclaration)
    .filter((node) => node.moduleSpecifier.text.endsWith("/packages/vault-crypto/src/aes-gcm.mjs"));
  if (ownerImports.length !== 1) FAIL(`${file} must import the shared AES-GCM owner exactly once`);
  const specifier = ownerImports[0].moduleSpecifier.text;
  const resolved = path.resolve(path.dirname(path.join(ROOT, file)), specifier);
  if (resolved !== path.join(ROOT, CORE)) FAIL(`${file} import resolves outside the shared crypto owner`);
  if (/\b(?:crypto|nodeCrypto)\.(?:createCipheriv|createDecipheriv|hkdfSync)\s*\(/.test(source)) {
    FAIL(`${file} still contains an inline AES or KEK-derivation implementation`);
  }
  consumers.push({ file, import: specifier, target: CORE });
}
if (/\b(?:crypto|nodeCrypto)\.(?:createCipheriv|createDecipheriv|hkdfSync)\s*\(/.test(read(CORE))) {
  FAIL("shared owner unexpectedly delegates its core implementation elsewhere");
}

function run(command, args, timeout = 180_000) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout,
    maxBuffer: 12 * 1024 * 1024,
  });
  return { ...result, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}
const tests = run("node", ["--test", TEST]);
if (tests.error || tests.status !== 0) {
  console.error(tests.output.slice(-12_000));
  FAIL(`shared crypto and vault-service compatibility tests failed (exit ${tests.status ?? "unknown"})`);
}
const apiTypecheck = run("pnpm", [
  "--filter", "@workspace/api-server", "exec", "tsc",
  "--noEmit", "--skipLibCheck", "--target", "es2022", "--module", "esnext",
  "--moduleResolution", "bundler", "--types", "node", "--strict",
  "--customConditions", "workspace",
  "src/vault/crypto/field-encryption.ts", "src/vault/crypto/seed-phrase.ts",
  "src/lib/wallet-crypto.ts", "src/vault/crypto/backup-envelope.ts",
]);
if (apiTypecheck.error || apiTypecheck.status !== 0) {
  console.error(apiTypecheck.output.slice(-12_000));
  FAIL(`crypto-owner TypeScript check failed (exit ${apiTypecheck.status ?? "unknown"})`);
}

const sourceHashes = Object.fromEntries([...CONSUMERS, CORE, TEST].map((file) => [file, sha256File(path.join(ROOT, file))]));
const evidence = {
  schema_version: 1,
  phase: "VLT-GAP-07",
  sub_phase: SUB_PHASE,
  ...binding(sourceHashes),
  source_hashes: sourceHashes,
  consumers_migrated: consumers,
  old_inline_cipher_consumers_remaining: [],
  tests: { command: "node --test packages/vault-crypto/src/aes-gcm.test.mjs", exit_code: tests.status },
  typecheck: { command: "targeted api-server TypeScript check for the four crypto owners", exit_code: apiTypecheck.status },
  status: "PASS",
};
const output = path.join(ROOT, EVIDENCE);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`${SUB_PHASE} PASS — ${consumers.length} consumers use the common owner, compatibility tests passed, and the crypto-owner typecheck passed`);