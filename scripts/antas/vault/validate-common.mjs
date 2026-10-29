import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const evidenceRoot = path.join(root, "reports/antas/vault");
const docsRoot = path.join(root, "docs/antas/vault");

const requiredModules = [
  "services/vault/src/index.mjs",
  "services/vault/src/api/http-handler.mjs",
  "services/vault/src/api/contracts.mjs",
  "services/vault/src/application/secret-service.mjs",
  "services/vault/src/domain/secret.mjs",
  "services/vault/src/crypto/envelope.mjs",
  "services/vault/src/security/access.mjs",
  "services/vault/src/infrastructure/dependencies.mjs",
  "artifacts/api-server/src/vault/domain/secret-fields.ts",
  "artifacts/api-server/src/vault/domain/serial.ts",
  "artifacts/api-server/src/vault/domain/entity-links.ts",
  "artifacts/api-server/src/vault/domain/local-account.ts",
  "artifacts/api-server/src/vault/domain/kyc.ts",
  "artifacts/api-server/src/vault/domain/game.ts",
  "artifacts/api-server/src/vault/crypto/field-encryption.ts",
  "artifacts/api-server/src/vault/crypto/seed-phrase.ts",
  "artifacts/api-server/src/vault/application/index.ts",
  "artifacts/api-server/src/vault/infrastructure/index.ts",
  "artifacts/api-server/src/vault/api/index.ts",
  "artifacts/api-server/src/routes/vault.ts",
];

const phaseCoverage = {
  "00": ["architecture.md", "module-ownership.md", "compatibility-freeze.md", "api-contract-inventory.md", "event-contract-inventory.md", "db-touch-inventory.md", "file-migration-map.md"],
  "01": ["architecture.md", "module-ownership.md"],
  "02": ["architecture.md", "compatibility-freeze.md"],
  "03": ["module-ownership.md", "compatibility-freeze.md"],
  "04": ["module-ownership.md", "file-migration-map.md"],
  "05": ["module-ownership.md", "file-migration-map.md"],
  "06": ["module-ownership.md", "file-migration-map.md"],
  "07": ["module-ownership.md", "file-migration-map.md"],
  "08": ["module-ownership.md", "compatibility-freeze.md"],
  "09": ["architecture.md", "db-touch-inventory.md"],
  "10": ["architecture.md", "db-touch-inventory.md"],
  "11": ["architecture.md", "compatibility-freeze.md"],
  "12": ["api-contract-inventory.md", "module-ownership.md"],
  "13": ["architecture.md", "db-touch-inventory.md"],
  "14": ["architecture.md", "module-ownership.md"],
  "15": ["api-contract-inventory.md", "compatibility-freeze.md"],
  "16": ["file-migration-map.md", "architecture.md"],
  "17": ["compatibility-freeze.md", "db-touch-inventory.md"],
  "18": ["architecture.md", "compatibility-freeze.md"],
  "19": ["architecture.md", "module-ownership.md", "compatibility-freeze.md", "api-contract-inventory.md", "event-contract-inventory.md", "db-touch-inventory.md", "file-migration-map.md"],
};

const exists = (relative) => fs.existsSync(path.join(root, relative));
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const check = (name, passed, details = "") => ({ name, passed: Boolean(passed), details });

function runSyntaxCheck(relative) {
  const result = spawnSync(process.execPath, ["--check", path.join(root, relative)], { encoding: "utf8" });
  return check(`syntax:${relative}`, result.status === 0, result.stderr?.trim() || "");
}

function validateOne(phase, subphase) {
  const phaseId = String(phase).padStart(2, "0");
  const subphaseId = String(subphase).toUpperCase();
  const id = `VLT-${phaseId}-${subphaseId}`;
  const checks = [];

  for (const file of requiredModules) checks.push(check(`required:${file}`, exists(file)));
  for (const file of phaseCoverage[phaseId] ?? []) checks.push(check(`documentation:${file}`, exists(`docs/antas/vault/${file}`)));
  checks.push(check("roadmap manifest", exists("config/antas/vault-roadmap.json")));
  checks.push(check("validator source", exists("scripts/antas/vault/validate-common.mjs")));
  checks.push(runSyntaxCheck("services/vault/src/index.mjs"));
   checks.push(runSyntaxCheck("services/vault/src/crypto/envelope.mjs"));
   checks.push(runSyntaxCheck("services/vault/src/security/access.mjs"));
   checks.push(runSyntaxCheck("services/vault/src/domain/secret.mjs"));
   checks.push(check("owned API tree", exists("artifacts/api-server/src/vault/api/index.ts")));
   checks.push(check("owned application tree", exists("artifacts/api-server/src/vault/application/index.ts")));
   checks.push(check("owned infrastructure tree", exists("artifacts/api-server/src/vault/infrastructure/index.ts")));

  if (phaseId === "00") {
    checks.push(check("inventory is classified", exists("docs/antas/vault/file-migration-map.md") && read("docs/antas/vault/file-migration-map.md").includes("Classification")));
    checks.push(check("public contract is frozen", read("docs/antas/vault/compatibility-freeze.md")?.includes("Frozen")));
  }
  if (phaseId === "02" || phaseId === "08") {
    checks.push(check("secret material is isolated", read("services/vault/src/index.mjs").includes("createVaultCrypto")));
    checks.push(check("plaintext is excluded from metadata", read("services/vault/src/domain.mjs").includes("metadataOnly")));
  }
  if (phaseId === "03" || phaseId === "12" || phaseId === "15") {
    checks.push(check("access boundary is present", read("services/vault/src/security/access.mjs").includes("verifyStepUpToken")));
    checks.push(check("route compatibility is documented", exists("docs/antas/vault/api-contract-inventory.md")));
  }
  if (phaseId === "14") {
    checks.push(check("architecture rules are executable", exists("scripts/validate-domain-boundaries.mjs")));
    checks.push(check("dependency graph is recorded", exists("docs/antas/vault/architecture.md")));
  }
  if (phaseId === "18") {
    checks.push(check("capacity evidence is explicit", exists("reports/antas/vault/18/capacity-report.json")));
  }
  if (phaseId === "19") {
    checks.push(check("all phase evidence is indexed", exists("reports/antas/vault/evidence-index.json")));
  }

  const failed = checks.filter((item) => !item.passed);
  const evidence = {
    schemaVersion: 1,
    roadmap: "ANTAS Vault Modularization",
    gate: id,
    status: failed.length === 0 ? "PASS" : "FAIL",
    generatedAt: new Date().toISOString(),
    checks,
    failureCount: failed.length,
    evidenceClass: "repository-and-static-compatibility",
    limitations: [
      "Provider-backed staging and production behavior require an environment-specific drill.",
      "No secret values or plaintext fixtures are stored in evidence.",
    ],
  };
  const outputDir = path.join(evidenceRoot, phaseId);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, `${subphaseId}-evidence.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  if (failed.length) {
    console.error(`${id} FAILED\n${failed.map((item) => `- ${item.name}: ${item.details || "not satisfied"}`).join("\n")}`);
    return false;
  }
  console.log(`${id} PASS`);
  return true;
}

const [, , phase, subphase] = process.argv;
if (!phase || !subphase) {
  console.error("Usage: node validate-common.mjs <phase> <subphase>");
  process.exit(2);
}

process.exit(validateOne(phase, subphase) ? 0 : 1);
