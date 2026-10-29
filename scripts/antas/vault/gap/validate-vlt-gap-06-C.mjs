#!/usr/bin/env node
// VLT-GAP-06-C — prove every PIN-guard consumer now uses the extracted owner.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { ROOT, binding, rejectBypass, rel, sha256File, walkFiles } from "./gap-common.mjs";

const PHASE = "VLT-GAP-06";
const SUB_PHASE = "VLT-GAP-06-C";
const NEW = "artifacts/api-server/src/vault/security/pin-guard.ts";
const LEGACY = "artifacts/api-server/src/lib/vault-pin-guard.ts";
const SECURITY_ROUTE = "artifacts/api-server/src/routes/vault-security.ts";
const SECURITY_REPOSITORY = "artifacts/api-server/src/vault/infrastructure/repositories/vault-security-repository.ts";
const REVEAL_OWNER = "artifacts/api-server/src/vault/security/reveal-token.ts";
const API_SRC = "artifacts/api-server/src";
const PRIOR_EVIDENCE = "reports/antas/vault/gap/VLT-GAP-06/extraction-proof.json";
const INVENTORY = "reports/antas/vault/gap/VLT-GAP-06/symbol-inventory.json";
const MANIFEST = "reports/antas/vault/gap/VLT-GAP-06/baseline/repo-manifest.json";
const EVIDENCE = "reports/antas/vault/gap/VLT-GAP-06/consumer-graph.json";
const REQUIRED_CONSUMERS = [
  "artifacts/api-server/src/routes/passkey.ts",
  "artifacts/api-server/src/routes/vault-security.ts",
];
const fail = (message) => { console.error(`${SUB_PHASE} FAIL — ${message}`); process.exit(1); };
const bypass = rejectBypass();
if (bypass.length) fail(`bypass rejected: ${bypass.join(", ")}`);

for (const file of [NEW, LEGACY, SECURITY_ROUTE, SECURITY_REPOSITORY, REVEAL_OWNER, PRIOR_EVIDENCE, INVENTORY, MANIFEST, ...REQUIRED_CONSUMERS]) {
  if (!fs.existsSync(path.join(ROOT, file))) fail(`required file/evidence missing: ${file}`);
}
const ts = createRequire(path.join(ROOT, "package.json"))("typescript");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const parse = (file, text) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const prior = JSON.parse(read(PRIOR_EVIDENCE));
if (prior.status !== "PASS" || prior.sub_phase !== "VLT-GAP-06-B") fail("06-B extraction evidence is not PASS");
if (prior.source_hashes?.[NEW] !== sha256File(path.join(ROOT, NEW))) fail("06-B extracted owner changed after its differential proof");
const census = JSON.parse(read(INVENTORY));
const manifest = JSON.parse(read(MANIFEST));
if (census.status !== "PASS" || census.sub_phase !== "VLT-GAP-06-A") fail("sealed 06-A census evidence is not PASS");
const securityBaseline = manifest.sources?.find((row) => row.file === SECURITY_ROUTE);
if (!securityBaseline || !fs.existsSync(path.join(ROOT, securityBaseline.baseline_copy))) {
  fail("06-A frozen Vault-security route baseline is missing");
}
if (sha256File(path.join(ROOT, securityBaseline.baseline_copy)) !== securityBaseline.sha256) {
  fail("06-A frozen Vault-security route baseline is corrupt");
}
const baselineTree = parse(securityBaseline.baseline_copy, read(securityBaseline.baseline_copy));
const baselineFunctions = new Map(baselineTree.statements
  .filter((node) => ts.isFunctionDeclaration(node) && node.name && node.body)
  .map((node) => [node.name.text, node]));
const repoTree = parse(SECURITY_REPOSITORY, read(SECURITY_REPOSITORY));
const revealTree = parse(REVEAL_OWNER, read(REVEAL_OWNER));
const movedFunctions = new Map([
  ...repoTree.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name && node.body)
    .map((node) => [node.name.text, node]),
  ...revealTree.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name && node.body)
    .map((node) => [node.name.text, node]),
]);
const revealFunctionNames = ["getRow", "mintRevealToken", "consumeRevealToken", "hasNoEntityPin"];
const revealBodyProof = revealFunctionNames.map((symbol) => {
  const before = baselineFunctions.get(symbol);
  const after = movedFunctions.get(symbol);
  if (!before || !after) fail(`security extraction symbol is missing: ${symbol}`);
  const beforeHash = sha256(before.body.getText());
  const afterHash = sha256(after.body.getText());
  if (beforeHash !== afterHash) fail(`security function body changed during extraction: ${symbol}`);
  return { symbol, from: SECURITY_ROUTE, to: symbol === "getRow" ? SECURITY_REPOSITORY : REVEAL_OWNER, before_body_sha256: beforeHash, after_body_sha256: afterHash };
});

const apiFiles = walkFiles(path.join(ROOT, API_SRC), [], (file) => /\.tsx?$/.test(file)).map(rel);
const importSpecifiers = new Map();
for (const file of apiFiles) {
  const tree = parse(file, read(file));
  if (tree.parseDiagnostics.length) fail(`TypeScript parse errors in ${file}`);
  importSpecifiers.set(file, tree.statements
    .filter(ts.isImportDeclaration)
    .map((node) => node.moduleSpecifier.text));
}
const actualLegacyConsumers = apiFiles.filter((file) => file !== LEGACY && importSpecifiers.get(file).includes("../lib/vault-pin-guard"));
if (actualLegacyConsumers.length) fail(`consumers still bypass the extracted owner through the legacy path: ${actualLegacyConsumers.join(", ")}`);
const actualNewConsumers = apiFiles.filter((file) => importSpecifiers.get(file).includes("../vault/security/pin-guard"));
const missingConsumers = REQUIRED_CONSUMERS.filter((file) => !actualNewConsumers.includes(file));
if (missingConsumers.length) fail(`required consumers do not import the new owner: ${missingConsumers.join(", ")}`);
const unexpected = actualNewConsumers.filter((file) => !REQUIRED_CONSUMERS.includes(file));
if (unexpected.length) fail(`unmapped new-owner consumers require review: ${unexpected.join(", ")}`);
const expectedRevealConsumers = [
  "artifacts/api-server/src/routes/vault-security.ts",
  "artifacts/api-server/src/routes/vault.ts",
  "artifacts/api-server/src/routes/wallets.ts",
];
const actualRevealConsumers = apiFiles.filter((file) => importSpecifiers.get(file).includes("../vault/security/reveal-token"));
const missingRevealConsumers = expectedRevealConsumers.filter((file) => !actualRevealConsumers.includes(file));
if (missingRevealConsumers.length) fail(`reveal-token consumers are not wired to the new owner: ${missingRevealConsumers.join(", ")}`);
const unexpectedRevealConsumers = actualRevealConsumers.filter((file) => !expectedRevealConsumers.includes(file));
if (unexpectedRevealConsumers.length) fail(`unmapped reveal-token consumers require review: ${unexpectedRevealConsumers.join(", ")}`);
for (const file of ["artifacts/api-server/src/routes/vault.ts", "artifacts/api-server/src/routes/wallets.ts"]) {
  if (importSpecifiers.get(file).includes("./vault-security")) fail(`${file} still imports reveal-token behavior from the route module`);
}
const securityRouteTree = parse(SECURITY_ROUTE, read(SECURITY_ROUTE));
const leftoverSecurityImplementations = securityRouteTree.statements
  .filter((node) => ts.isFunctionDeclaration(node) && node.name && revealFunctionNames.includes(node.name.text));
if (leftoverSecurityImplementations.length) fail("Vault-security route still owns extracted repository/reveal-token implementations");

const typecheck = spawnSync("pnpm", [
  "--filter", "@workspace/api-server", "exec", "tsc",
  "--noEmit", "--skipLibCheck", "--target", "es2022", "--module", "esnext",
  "--moduleResolution", "bundler", "--types", "node", "--strict",
  "--customConditions", "workspace",
  "src/vault/security/pin-guard.ts", "src/vault/security/reveal-token.ts",
  "src/vault/infrastructure/repositories/vault-security-repository.ts",
  "src/routes/passkey.ts", "src/routes/vault-security.ts", "src/routes/vault.ts", "src/routes/wallets.ts",
], { cwd: ROOT, encoding: "utf8", timeout: 180_000, maxBuffer: 12 * 1024 * 1024 });
if (typecheck.error || typecheck.status !== 0) {
  console.error(`${typecheck.stdout ?? ""}${typecheck.stderr ?? ""}`.slice(-12_000));
  fail(`rewired-source TypeScript check failed (exit ${typecheck.status ?? "unknown"})`);
}

const paths = [NEW, LEGACY, SECURITY_ROUTE, SECURITY_REPOSITORY, REVEAL_OWNER,
  "artifacts/api-server/src/routes/vault.ts", "artifacts/api-server/src/routes/wallets.ts", ...REQUIRED_CONSUMERS];
const sourceHashes = Object.fromEntries(paths.map((file) => [file, sha256File(path.join(ROOT, file))]));
const evidence = {
  schema_version: 1,
  phase: PHASE,
  sub_phase: SUB_PHASE,
  validator_version: "1.0.0",
  ...binding(sourceHashes),
  source_hashes: sourceHashes,
  commands: ["node scripts/antas/vault/gap/validate-vlt-gap-06-C.mjs", "targeted TypeScript check for PIN guard and its direct route consumers"],
  exit_codes: { "rewired-source TypeScript check": typecheck.status },
  consumers_migrated: [
    ...REQUIRED_CONSUMERS.map((file) => ({ file, import: "../vault/security/pin-guard", target: NEW })),
    ...expectedRevealConsumers.map((file) => ({ file, import: "../vault/security/reveal-token", target: REVEAL_OWNER })),
  ],
  legacy_consumers_remaining: [],
  new_owner_consumers: actualNewConsumers,
  pin_guard_body_hashes_preserved: prior.symbols_moved.map((symbol) => ({
    symbol: symbol.symbol,
    source_sha256: symbol.before_body_sha256,
    destination_sha256: symbol.after_body_sha256,
  })),
  reveal_security_body_hashes_preserved: revealBodyProof,
  status: "PASS",
};
const output = path.join(ROOT, EVIDENCE);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`${SUB_PHASE} PASS — PIN and reveal-token consumers use the new owners; four Vault-security functions moved unchanged; targeted typecheck passed`);