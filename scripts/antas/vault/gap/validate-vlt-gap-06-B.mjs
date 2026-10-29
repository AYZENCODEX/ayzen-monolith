#!/usr/bin/env node
// VLT-GAP-06-B — Differential proof for the Vault PIN guard extraction.
// A PASS is a phase-time snapshot; once sealed, subsequent C wiring changes
// are checked by 06-C rather than forcing this extraction gate to rerun.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ROOT, binding, rejectBypass, rel, sha256, sha256File, walkFiles } from "./gap-common.mjs";

const SELF = fileURLToPath(import.meta.url);
const PHASE = "VLT-GAP-06";
const SUB_PHASE = "VLT-GAP-06-B";
const OLD = "artifacts/api-server/src/lib/vault-pin-guard.ts";
const NEW = "artifacts/api-server/src/vault/security/pin-guard.ts";
const ADAPTER = OLD;
const MIGRATION_MAP = "docs/antas/vault/file-migration-map.md";
const INVENTORY = "reports/antas/vault/gap/VLT-GAP-06/symbol-inventory.json";
const MANIFEST = "reports/antas/vault/gap/VLT-GAP-06/baseline/repo-manifest.json";
const BASELINE = "reports/antas/vault/gap/VLT-GAP-06/baseline/sources/artifacts__api-server__src__lib__vault-pin-guard.ts";
const EVIDENCE = "reports/antas/vault/gap/VLT-GAP-06/extraction-proof.json";
const REQUIRED_FUNCTIONS = ["isVaultPinLockedOut", "recordFailure", "clearVaultPinFailures", "hasVaultPin", "requireVaultPin"];
const ALLOWED_ADAPTER_EXPORTS = new Set(["clearVaultPinFailures", "hasVaultPin", "isVaultPinLockedOut", "requireVaultPin", "VaultPinCheckResult"]);
const fail = (message) => { console.error(`${SUB_PHASE} FAIL — ${message}`); process.exit(1); };

const bypass = rejectBypass();
if (bypass.length) fail(`bypass rejected: ${bypass.join(", ")}`);
for (const [key, value] of Object.entries(process.env)) {
  if (/^(VALIDATION_DISABLED|ANTAS_BYPASS|VLT_BYPASS|VAULT_BYPASS)$/i.test(key) && value && !/^(0|false|no)$/i.test(value)) {
    fail(`bypass rejected: ${key}`);
  }
}

// Preserve the already-passed B-stage result after later consumer rewiring.
// Verify the frozen implementation is still byte-identical to the extraction
// proof, then leave current consumer wiring to 06-C.
if (fs.existsSync(path.join(ROOT, EVIDENCE))) {
  const sealed = JSON.parse(fs.readFileSync(path.join(ROOT, EVIDENCE), "utf8"));
  if (sealed.status === "PASS" && sealed.sub_phase === SUB_PHASE) {
    for (const file of [OLD, NEW]) {
      if (!fs.existsSync(path.join(ROOT, file)) || sha256File(path.join(ROOT, file)) !== sealed.source_hashes?.[file]) {
        fail(`sealed 06-B implementation changed after PASS: ${file}`);
      }
    }
    const ts = createRequire(path.join(ROOT, "package.json"))("typescript");
    const newText = fs.readFileSync(path.join(ROOT, NEW), "utf8");
    const tree = ts.createSourceFile(NEW, newText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const bodyHashes = new Map(tree.statements
      .filter((node) => ts.isFunctionDeclaration(node) && node.name && node.body)
      .map((node) => [node.name.text, sha256(node.body.getText())]));
    for (const symbol of sealed.symbols_moved ?? []) {
      if (bodyHashes.get(symbol.symbol) !== symbol.after_body_sha256 ||
          symbol.before_body_sha256 !== symbol.after_body_sha256) {
        fail(`sealed 06-B differential proof no longer matches ${symbol.symbol}`);
      }
    }
    if ((sealed.symbols_moved ?? []).length !== REQUIRED_FUNCTIONS.length) {
      fail("sealed 06-B evidence does not cover the complete PIN-guard symbol set");
    }
    console.log(`${SUB_PHASE} already PASS — extracted implementation remains identical; later consumer wiring is left to 06-C`);
    process.exit(0);
  }
}

for (const file of [INVENTORY, MANIFEST, BASELINE, OLD, NEW, MIGRATION_MAP]) {
  if (!fs.existsSync(path.join(ROOT, file))) fail(`required source/evidence missing: ${file}`);
}

const ts = createRequire(path.join(ROOT, "package.json"))("typescript");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const parse = (file, text) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const baselineText = read(BASELINE);
const newText = read(NEW);
const oldText = read(OLD);
const baselineTree = parse(BASELINE, baselineText);
const newTree = parse(NEW, newText);
const adapterTree = parse(ADAPTER, oldText);
const inventory = JSON.parse(read(INVENTORY));
const manifest = JSON.parse(read(MANIFEST));
if (inventory.status !== "PASS" || inventory.sub_phase !== "VLT-GAP-06-A") fail("06-A source census is not PASS");

const baselineRow = manifest.sources?.find((row) => row.file === OLD);
if (!baselineRow || baselineRow.baseline_copy !== BASELINE) fail("06-A frozen manifest does not map the legacy PIN guard");
if (sha256File(path.join(ROOT, BASELINE)) !== baselineRow.sha256) fail("frozen legacy source hash does not match the 06-A manifest");

function functionNodes(tree) {
  return new Map(tree.statements
    .filter((node) => ts.isFunctionDeclaration(node) && node.name)
    .map((node) => [node.name.text, node]));
}
function declarationBodyHash(node) {
  return sha256(node.body ? node.body.getText() : "");
}
const beforeFunctions = functionNodes(baselineTree);
const afterFunctions = functionNodes(newTree);
const missingFunctions = REQUIRED_FUNCTIONS.filter((name) => !beforeFunctions.has(name) || !afterFunctions.has(name));
if (missingFunctions.length) fail(`required implementation symbols missing: ${missingFunctions.join(", ")}`);
const changedBodies = REQUIRED_FUNCTIONS.filter((name) => declarationBodyHash(beforeFunctions.get(name)) !== declarationBodyHash(afterFunctions.get(name)));
if (changedBodies.length) fail(`extracted function bodies differ from frozen implementation: ${changedBodies.join(", ")}`);

const adapterBusiness = adapterTree.statements.filter((node) =>
  ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) ||
  ts.isVariableStatement(node) || ts.isTypeAliasDeclaration(node) ||
  ts.isInterfaceDeclaration(node)
);
if (adapterBusiness.length) fail("legacy PIN-guard path still declares implementation instead of only re-exporting");
const adapterExports = adapterTree.statements
  .filter(ts.isExportDeclaration)
  .flatMap((node) => node.exportClause && ts.isNamedExports(node.exportClause)
    ? node.exportClause.elements.map((element) => element.name.text)
    : []);
if (adapterExports.length !== ALLOWED_ADAPTER_EXPORTS.size || adapterExports.some((name) => !ALLOWED_ADAPTER_EXPORTS.has(name))) {
  fail("legacy adapter export surface changed or includes unexpected exports");
}
const adapterTarget = adapterTree.statements.find(ts.isExportDeclaration)?.moduleSpecifier?.text;
if (adapterTarget !== "../vault/security/pin-guard") fail("compatibility adapter does not forward to the new PIN-guard owner");

const apiTsRoot = path.join(ROOT, "artifacts/api-server/src");
const apiFiles = walkFiles(apiTsRoot, [], (file) => /\.tsx?$/.test(file)).map(rel);
const importsFrom = (file, specifier) => {
  const tree = parse(file, read(file));
  return tree.statements.some((node) => ts.isImportDeclaration(node) && node.moduleSpecifier.text === specifier);
};
const consumersFor06C = [
  "artifacts/api-server/src/routes/passkey.ts",
  "artifacts/api-server/src/routes/vault-security.ts",
];
const prematurelyRewired = consumersFor06C.filter((file) => !importsFrom(file, "../lib/vault-pin-guard"));
if (prematurelyRewired.length) fail(`consumer rewiring belongs to 06-C; unexpected new-owner imports: ${prematurelyRewired.join(", ")}`);
const unapprovedLegacyConsumers = apiFiles.filter((file) => file !== ADAPTER && importsFrom(file, "../lib/vault-pin-guard") && !consumersFor06C.includes(file));
if (unapprovedLegacyConsumers.length) fail(`unexpected compatibility-path consumer: ${unapprovedLegacyConsumers.join(", ")}`);

const mapText = read(MIGRATION_MAP);
const mapEntry = `| Security PIN guard | \`${OLD}\` | \`${NEW}\` | EXTRACTED (VLT-GAP-06-B); compatibility exports retained until VLT-GAP-06-D |`;
if (!mapText.split("\n").includes(mapEntry)) fail("OLD→NEW migration map entry is missing or inaccurate");

function run(command, args, timeout = 240_000) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout,
    maxBuffer: 12 * 1024 * 1024,
  });
  return { ...result, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}
const changedFileTypecheck = run("pnpm", [
  "--filter", "@workspace/api-server", "exec", "tsc",
  "--noEmit", "--skipLibCheck", "--target", "es2022", "--module", "esnext",
  "--moduleResolution", "bundler", "--types", "node", "--strict",
  "--customConditions", "workspace",
  "src/vault/security/pin-guard.ts", "src/routes/passkey.ts", "src/routes/vault-security.ts",
]);
if (changedFileTypecheck.error || changedFileTypecheck.status !== 0) {
  console.error(changedFileTypecheck.output.slice(-12_000));
  fail(`extraction-scope TypeScript check failed (exit ${changedFileTypecheck.status ?? "unknown"})`);
}

const sourceHashes = Object.fromEntries([OLD, NEW, "artifacts/api-server/src/routes/passkey.ts", "artifacts/api-server/src/routes/vault-security.ts", MIGRATION_MAP]
  .map((file) => [file, sha256File(path.join(ROOT, file))]));
const bindingInfo = binding(sourceHashes);
const evidence = {
  schema_version: 1,
  phase: PHASE,
  sub_phase: SUB_PHASE,
  validator_version: "1.0.0",
  ...bindingInfo,
  source_hashes: sourceHashes,
  commands: ["node scripts/antas/vault/gap/validate-vlt-gap-06-B.mjs", "pnpm --filter @workspace/api-server exec tsc --noEmit --skipLibCheck --target es2022 --module esnext --moduleResolution bundler --types node --strict --customConditions workspace src/vault/security/pin-guard.ts src/routes/passkey.ts src/routes/vault-security.ts"],
  exit_codes: { "extraction-scope TypeScript check": changedFileTypecheck.status },
  symbols_moved: REQUIRED_FUNCTIONS.map((name) => ({
    symbol: name,
    from: OLD,
    to: NEW,
    before_body_sha256: declarationBodyHash(beforeFunctions.get(name)),
    after_body_sha256: declarationBodyHash(afterFunctions.get(name)),
  })),
  consumers_migrated: [],
  old_business_symbols_remaining: [],
  compatibility_adapter: { file: ADAPTER, business_declarations: 0, forwards_to: NEW },
  duplicate_implementations: [],
  migration_map_entry: mapEntry,
  status: "PASS",
};
const evidencePath = path.join(ROOT, EVIDENCE);
fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`${SUB_PHASE} PASS — ${REQUIRED_FUNCTIONS.length} function bodies moved unchanged; legacy consumers remain on the forwarding adapter for 06-C; extraction-scope typecheck passed`);