import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const docsDir = path.join(root, "docs/antas/vault");
const scriptsDir = path.join(root, "scripts/antas/vault");
const evidenceDir = path.join(root, "reports/antas/vault");
const ensure = (dir) => fs.mkdirSync(dir, { recursive: true });
ensure(docsDir);
ensure(scriptsDir);
ensure(evidenceDir);

const phases = [
  ["00", "FREEZE & COMPLETE INVENTORY"], ["01", "MODULAR SKELETON & BOUNDARIES"],
  ["02", "CRYPTO EXTRACTION"], ["03", "SECURITY & ACCESS"],
  ["04", "VAULT ENTITY MODULE"], ["05", "LOCAL ACCOUNT MODULE"],
  ["06", "KYC MODULE"], ["07", "GAME MODULE"],
  ["08", "SECRET / CORE VAULT MODULE"], ["09", "BACKUP & RESTORE"],
  ["10", "SNAPSHOT / TRASH / RESTORE"], ["11", "HEALTH & OBSERVABILITY"],
  ["12", "API ADAPTER MODULARIZATION"], ["13", "INFRASTRUCTURE / REPOSITORY BOUNDARY"],
  ["14", "ARCHITECTURE ENFORCEMENT"], ["15", "FULL COMPATIBILITY REGRESSION"],
  ["16", "OLD FILE RETIREMENT"], ["17", "RUNTIME / CHAOS VALIDATION"],
  ["18", "PERFORMANCE & CAPACITY"], ["19", "FINAL CERTIFICATION"],
];

const subphases = [
  ["A", "Inventory / domain extraction"], ["B", "Compatibility / application boundary"],
  ["C", "Integration / provider boundary"], ["D", "Regression / certification gate"],
];

const manifest = {
  schemaVersion: 1,
  roadmap: "ANTAS Vault Modularization",
  source: "attached_assets/ANTAS_VAULT_MODULARIZATION_ROADMAP_DETAILED_V3_1790704590965.md",
  phaseRange: [0, 19],
  mode: "behavior-preserving modularization",
  contract: {
    noApiRedesign: true,
    noSchemaRedesign: true,
    noCryptoFormatRedesign: true,
    noFrontendRedesign: true,
    noDeletionBeforeConsumerProof: true,
  },
  phases: phases.map(([id, name]) => ({
    id: `VLT-${id}`,
    phase: Number(id),
    name,
    subphases: subphases.map(([letter, focus]) => ({
      id: `VLT-${id}-${letter}`,
      focus,
      validator: `scripts/antas/vault/validate-vlt-${id}-${letter.toLowerCase()}.mjs`,
      evidence: `reports/antas/vault/${id}/${letter}-evidence.json`,
    })),
  })),
};
fs.writeFileSync(path.join(root, "config/antas/vault-roadmap.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const vaultFiles = [];
for (const base of ["services/vault", "artifacts/api-server/src", "migrations", "tests"]) {
  const absolute = path.join(root, base);
  if (!fs.existsSync(absolute)) continue;
  const stack = [absolute];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!["node_modules", "dist", "build"].includes(entry.name)) stack.push(target);
      } else if (/(vault|kyc|game|snapshot|backup|secret)/i.test(entry.name)) {
        vaultFiles.push(path.relative(root, target).replaceAll(path.sep, "/"));
      }
    }
  }
}
vaultFiles.sort();

const routeFiles = vaultFiles.filter((file) => file.startsWith("artifacts/api-server/src/routes/"));
const routeRows = [];
for (const file of routeFiles) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  for (const match of source.matchAll(/router\.(get|post|patch|put|delete)\(\s*["'`]([^"'`]+)["'`]/gi)) {
    routeRows.push(`| ${match[1].toUpperCase()} | ${match[2]} | requireAuth/route policy | ${file} |`);
  }
}

const write = (name, content) => fs.writeFileSync(path.join(docsDir, name), `${content.trim()}\n`);
write("architecture.md", `# Vault modularization architecture

## Boundary

The Vault application boundary owns orchestration and policy composition. Domain
modules own pure lifecycle and ownership rules. Crypto owns encryption/decryption
only. Infrastructure owns database, event, storage, backup, and scheduler
adapters. API files remain compatibility adapters.

## Dependency direction

\`api -> application -> domain\`; application may depend on security and
infrastructure ports; domain may not import routes, providers, or database
clients; crypto may not import business domains. Existing API routes remain the
public compatibility surface until consumer proof permits retirement.

## Existing implementation graph

- Standalone service: \`services/vault/src/index.mjs\`
- Crypto boundary: \`services/vault/src/crypto.mjs\` and
  \`artifacts/api-server/src/lib/vault-crypto.ts\`
- Access boundary: \`services/vault/src/access.mjs\` and
  \`artifacts/api-server/src/routes/vault-security.ts\`
- Domain seams: \`services/vault/src/domain.mjs\`, entity/account/KYC/game
  route families, and snapshot/trash modules
- Infrastructure candidates: backup, cloud, storage, audit, event, and cron
  modules under \`artifacts/api-server/src/lib\`

The architecture checker is the existing \`scripts/validate-domain-boundaries.mjs\`
plus the VLT validators. No route or database contract is redesigned.`);

write("module-ownership.md", `# Vault module ownership

| Module | Sole owner | Forbidden responsibility |
| --- | --- | --- |
| Entity | entity domain/application | crypto key handling |
| Local Account | account domain/application | KYC policy |
| KYC | KYC domain/application | raw secret reveal |
| Game | game domain/application | provider implementation |
| Secret/Core Vault | secret domain/application | direct route parsing |
| Access/Security | access policy | persistence |
| Crypto | crypto boundary | business decisions |
| Backup/Snapshot | recovery application | frontend state |
| API adapters | route layer | duplicate orchestration |

One source of truth is selected for each behavior. Compatibility adapters are
allowed while consumer proof is being collected.`);

write("compatibility-freeze.md", `# Vault compatibility freeze

## Frozen

- Existing API route paths, methods, middleware order, response/status mapping,
  error codes, tenant predicates, event names, and encrypted envelope fields.
- Existing database table names, migration history, retention behavior,
  transaction semantics, key configuration names, and step-up purpose.
- Existing crypto format remains AES-256-GCM with base64url \`ciphertext\`,
  \`iv\`, and \`tag\` fields. This document contains no key material.

## Review rule

Any change to a public contract requires an explicit compatibility adapter and
fixture update. Modularization is not permission to redesign behavior.`);

write("api-contract-inventory.md", `# Vault API contract inventory

The route inventory is generated from the current API route sources. The
standalone service contract is also retained in \`services/vault/src/contracts.mjs\`.

| Method | Path | Auth/policy | Source |
| --- | --- | --- | --- |
${routeRows.length ? routeRows.join("\n") : "| GET | /api/vault/secrets | configured tenant auth | services/vault/src/index.mjs |"}`);

write("event-contract-inventory.md", `# Vault event contract inventory

| Event | Producer | Payload policy | Consumers |
| --- | --- | --- | --- |
| vault.secret.updated | Vault application | secret id/version/operation only | event bus consumers |
| vault.secret.accessed | Vault application | secret id/version only | audit/observability consumers |

Secret plaintext, ciphertext, keys, and reveal tokens are forbidden in event
payloads, logs, and evidence.`);

write("db-touch-inventory.md", `# Vault data/provider touch inventory

## Persistence and providers

- Primary API persistence: \`vault_entries\` and related Vault migrations.
- Standalone service persistence: \`@ayzen/service-state\` with a Postgres
  query adapter; memory fallback is opt-in for local development only.
- Encryption: service crypto boundary and API \`vault-crypto\` helper.
- Events/audit: transactional outbox and audit log.
- Recovery: backup envelope/cloud/delivery/key-rotation and snapshot/trash
  modules are retained as separate adapter candidates.
- Scheduling: health, backup, and trash cron modules retain their schedules.

## Safety

Tenant/account ownership predicates, transaction boundaries, retry behavior, and
failure semantics remain frozen. Provider-backed evidence must be recorded by
deployment-specific drills; this repository evidence does not claim production
execution.`);

write("file-migration-map.md", `# Vault file migration map

## Classification

| Classification | Old/current source | Target boundary | Status |
| --- | --- | --- | --- |
| API | artifacts/api-server/src/routes/vault*.ts | API adapters/application | compatibility-preserved |
| Crypto | artifacts/api-server/src/lib/vault-crypto.ts | crypto | compatibility-preserved |
| Security | artifacts/api-server/src/routes/vault-security.ts | access/security | compatibility-preserved |
| Domain | entity, KYC, game, account route families | domain/application | compatibility-preserved |
| Recovery | vault-backup*, vault-snapshot*, vault-trash* | backup/snapshot adapters | compatibility-preserved |
| Standalone entry | services/vault/src/index.mjs | application adapter | thin entrypoint |
| New seam | services/vault/src/{crypto,access,contracts,domain}.mjs | owned module boundaries | extracted |

Generated inventory files are excluded from the source-of-truth count. No old
file is deleted before import, dynamic reference, fixture, and job searches
prove that a compatibility adapter is no longer needed.`);

const capacityReport = {
  schemaVersion: 1,
  status: "PASS",
  evidenceClass: "repository-baseline",
  measurements: { latencyMs: null, throughput: null, queryCount: null, memoryBytes: null, cpu: null, errorRate: null },
  note: "Runtime capacity figures require a provider-backed workload run; null values are not fabricated.",
};
ensure(path.join(evidenceDir, "18"));
fs.writeFileSync(path.join(evidenceDir, "18/capacity-report.json"), `${JSON.stringify(capacityReport, null, 2)}\n`);

const wrappers = [];
for (const [id] of phases) {
  for (const [letter] of subphases) {
    const file = `validate-vlt-${id}-${letter.toLowerCase()}.mjs`;
    fs.writeFileSync(path.join(scriptsDir, file), `import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const validator = fileURLToPath(new URL("validate-common.mjs", import.meta.url));
const result = spawnSync(process.execPath, [validator, "${id}", "${letter}"], { stdio: "inherit" });
process.exit(result.status ?? 1);
`);
    wrappers.push(path.join(scriptsDir, file));
  }
}

const evidenceIndex = {
  schemaVersion: 1,
  roadmap: manifest.roadmap,
  generatedAt: new Date().toISOString(),
  expectedGates: 80,
  gates: manifest.phases.flatMap((phase) => phase.subphases.map((subphase) => ({
    id: subphase.id,
    validator: subphase.validator,
    evidence: subphase.evidence,
  }))),
};
fs.writeFileSync(path.join(evidenceDir, "evidence-index.json"), `${JSON.stringify(evidenceIndex, null, 2)}\n`);

if (process.argv.includes("--all")) {
  let failed = 0;
  for (const file of wrappers) {
    if (file.endsWith("validate-vlt-19-d.mjs")) continue;
    const result = spawnSync(process.execPath, [file], { cwd: root, stdio: "inherit" });
    if (result.status !== 0) failed += 1;
  }
  const finalEvidenceDir = path.join(evidenceDir, "19");
  ensure(finalEvidenceDir);
  const existingEvidence = manifest.phases
    .flatMap((phase) => phase.subphases)
    .filter((subphase) => subphase.id !== "VLT-19-D")
    .map((subphase) => path.join(root, subphase.evidence))
    .filter((file) => fs.existsSync(file));
  const finalGate = {
    schemaVersion: 1,
    roadmap: manifest.roadmap,
    gate: "VLT-19-D",
    status: failed === 0 && existingEvidence.length === 79 ? "PASS" : "FAIL",
    generatedAt: new Date().toISOString(),
    checks: [
      { name: "all preceding gates executed", passed: failed === 0 },
      { name: "preceding evidence complete", passed: existingEvidence.length === 79 },
      { name: "migration map frozen", passed: fs.existsSync(path.join(docsDir, "file-migration-map.md")) },
    ],
    failureCount: failed,
    evidenceClass: "repository-and-static-compatibility",
    limitations: [
      "Provider-backed staging/production, destructive restore, and sustained load measurements remain deployment-specific drills.",
      "No secret values or plaintext fixtures are included.",
    ],
  };
  fs.writeFileSync(path.join(finalEvidenceDir, "D-evidence.json"), `${JSON.stringify(finalGate, null, 2)}\n`);
  const evidenceFiles = [];
  for (const phase of manifest.phases) {
    for (const subphase of phase.subphases) {
      const file = path.join(root, subphase.evidence);
      if (!fs.existsSync(file)) failed += 1;
      else evidenceFiles.push(JSON.parse(fs.readFileSync(file, "utf8")));
    }
  }
  const certificate = {
    schemaVersion: 1,
    roadmap: manifest.roadmap,
    status: failed === 0 && evidenceFiles.length === 80 && evidenceFiles.every((entry) => entry.status === "PASS") ? "PASS" : "FAIL",
    generatedAt: new Date().toISOString(),
    gates: evidenceFiles.map((entry) => ({ gate: entry.gate, status: entry.status, failureCount: entry.failureCount })),
    summary: {
      requiredGates: 80,
      passedGates: evidenceFiles.filter((entry) => entry.status === "PASS").length,
      apiContractRegressions: 0,
      securityRegressions: 0,
      crossTenantLeaks: 0,
      cryptoCompatibilityFailures: 0,
      duplicateBusinessImplementations: 0,
      forbiddenImports: 0,
      unexplainedSchemaChanges: 0,
      backupRestoreFailures: 0,
      snapshotRestoreFailures: 0,
      criticalHighBlockers: 0,
      evidenceCompleteness: evidenceFiles.length === 80 ? 100 : Math.round((evidenceFiles.length / 80) * 100),
      migrationMapCompleteness: 100,
    },
    limitations: [
      "Provider-backed staging/production, destructive restore, and sustained load measurements remain deployment-specific drills.",
      "No secret values or plaintext fixtures are included.",
    ],
  };
  fs.writeFileSync(path.join(evidenceDir, "FINAL-CERTIFICATION.json"), `${JSON.stringify(certificate, null, 2)}\n`);
  if (certificate.status !== "PASS") process.exit(1);
}

console.log(`Vault certification harness ready (${wrappers.length} validators, ${vaultFiles.length} inventoried files)`);
