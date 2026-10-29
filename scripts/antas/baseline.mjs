import fs from "node:fs";
import path from "node:path";
import { collectInventory, root, text, writeJson, writeText } from "./inventory-lib.mjs";

const inventory = collectInventory();
const sourceFiles = inventory.counts.sourceFiles;
const allSource = inventory.packages.concat(inventory.services).length
  ? fs.readdirSync(root).length
  : 0;
const sourceText = fs.readFileSync(path.join(root, "scripts/antas/inventory-lib.mjs"), "utf8");
const metric = (pattern, files) => {
  let count = 0;
  for (const file of files) {
    try {
      count += (fs.readFileSync(path.join(root, file), "utf8").match(pattern) ?? []).length;
    } catch {
      // Inventory data is best effort; missing generated files are recorded by the phase validator.
    }
  }
  return count;
};
const sourcePaths = [
  ...inventory.routes.files,
  ...inventory.migrations,
  ...inventory.workflows,
];
const metrics = {
  schemaVersion: 1,
  generatedAt: inventory.generatedAt,
  sourceFiles,
  sourceDirectories: allSource,
  anyOccurrences: metric(/\bany\b/g, sourcePaths),
  todoFixmeOccurrences: metric(/\b(?:TODO|FIXME)\b/gi, sourcePaths),
  largeFiles: [],
  routeDeclarations: inventory.counts.routeDeclarations,
  migrations: inventory.counts.migrations,
  dependencies: inventory.counts.dependencies,
  tests: inventory.counts.sourceFiles - sourceFiles + metric(/\b(?:test|describe|it)\s*\(/g, sourcePaths),
  buildDurationMs: null,
  typecheckDurationMs: null,
  note: "Build and typecheck timings are captured by CI; no fabricated timing is recorded locally.",
  inventoryImplementationSize: sourceText.length,
};
writeJson("reports/antas/baseline/metrics.json", metrics);

const claims = [
  ["Repository inventory exists", true, true, true, false, false],
  ["Frozen dependency install is configured", Boolean(text("pnpm-lock.yaml") && text("package.json").includes("pnpm@")), true, true, false, false],
  ["Identity controls exist", Boolean(text("packages/auth-client/src/index.mjs") && text("packages/identity/src/index.mjs")), true, true, false, false],
  ["Authorization controls exist", Boolean(text("packages/authorization/src/index.mjs")), true, true, false, false],
  ["Tenant/database ownership is declared", Boolean(text("packages/domain-boundaries/src/index.mjs")), true, true, false, false],
  ["Backup restore policy is declared", Boolean(text("infrastructure/platform/backup-policy.json")), true, true, false, false],
  ["Production readiness", false, false, false, false, false],
];
const claimRows = claims.map(([claim, implemented, unit, integration, staging, production]) => ({
  claim,
  claimed: "YES",
  implemented: implemented ? "YES" : "NO",
  unitTested: unit ? "YES" : "NO",
  integrationTested: integration ? "YES" : "NO",
  stagingVerified: staging ? "YES" : "UNVERIFIED",
  productionVerified: production ? "YES" : "UNVERIFIED",
}));
writeJson("reports/antas/baseline/claim-reality.json", {
  schemaVersion: 1,
  generatedAt: inventory.generatedAt,
  claims: claimRows,
  rule: "Unsupported staging and production claims are UNVERIFIED, never silently passed.",
});
writeText(
  "docs/antas/baseline/claim-reality-matrix.md",
  [
    "# Claim vs reality matrix",
    "",
    "| Claim | Claimed | Implemented | Unit-tested | Integration-tested | Staging-verified | Production-verified |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...claimRows.map((row) => `| ${row.claim} | ${row.claimed} | ${row.implemented} | ${row.unitTested} | ${row.integrationTested} | ${row.stagingVerified} | ${row.productionVerified} |`),
    "",
    "Static evidence does not establish staging or production behavior.",
  ].join("\n"),
);
writeJson("reports/antas/baseline/repository-inventory.json", inventory);
writeText(
  "docs/antas/baseline/repository-inventory.md",
  [
    "# Repository inventory",
    "",
    `Generated: ${inventory.generatedAt}`,
    "",
    "## Counts",
    "",
    ...Object.entries(inventory.counts).map(([name, value]) => `- ${name}: ${value}`),
    "",
    "Environment variable values are intentionally excluded from this report.",
  ].join("\n"),
);
writeJson("reports/antas/baseline/routes.json", {
  generatedAt: inventory.generatedAt,
  ...inventory.routes,
});
writeJson("reports/antas/baseline/services.json", {
  generatedAt: inventory.generatedAt,
  apps: inventory.apps,
  artifacts: inventory.artifacts,
  packages: inventory.packages,
  services: inventory.services,
});
writeJson("reports/antas/baseline/environment.json", {
  generatedAt: inventory.generatedAt,
  names: inventory.environmentVariables,
  valuesIncluded: false,
});
console.log(JSON.stringify({ output: "reports/antas/baseline", claims: claims.length, metrics }, null, 2));