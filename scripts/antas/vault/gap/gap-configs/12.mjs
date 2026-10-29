// Config for scripts/antas/vault/gap/validate-gap.mjs — VLT-GAP-12 (Infrastructure: repositories / storage / providers / events / jobs).
// 12-A seals a source-derived census of EVERY direct infrastructure access left in Vault behavior code and classifies it.
// 12-B moves the verbatim-movable tranche (symbols whose body is pure persistence, or pure helpers they need) into
// vault/infrastructure + vault/domain. Mixed logic+persistence symbols are NOT rewritten here: they stay classified
// `split-required` in the sealed census and are the work of the next 12 sub-phase.
import path from "node:path";
import fs from "node:fs";
const API = "artifacts/api-server/src";
const V = `${API}/vault`, APP = `${V}/application`, REPOS = `${V}/infrastructure/repositories`, DOM = `${V}/domain`;
const SECTIONS_OLD = `${APP}/snapshot/sections.ts`, SECTIONS_REPO = `${REPOS}/snapshot-sections-repository.ts`;
const RESTORE = `${APP}/snapshot/restore.ts`, RESTORE_REPO = `${REPOS}/snapshot-restore-repository.ts`, RESTORE_KEYS = `${DOM}/snapshot-restore-keys.ts`;
const RECEIPT = `${APP}/entity/receipt.ts`, ENTITY_REPO = `${REPOS}/entity-repository.ts`;
const PIN_GUARD = `${V}/security/pin-guard.ts`, SEC_REPO = `${REPOS}/vault-security-repository.ts`;
const KYC_OWN = `${V}/security/kyc-ownership.ts`, KYC_REPO = `${REPOS}/kyc-repository.ts`;
const sm = (from, to, names) => names.map((name) => ({ from, name, to }));

const moves = { [SECTIONS_OLD]: SECTIONS_REPO };
const RESTORE_KEY_SYMS = ["RestoreTableKey", "RawTablePlan", "norm", "vaultKey", "walletKey", "rawRowKey", "dataEntityKey", "emailAccountKey", "MESSAGE_INSERT_COLS", "DATA_ENTITY_INSERT_COLS", "EMAIL_ACCOUNT_INSERT_COLS"];
const RESTORE_DB_SYMS = ["DbHandle", "existingVaultKeys", "insertVaultRow", "existingWalletKeys", "insertWalletRow", "existingRawKeys", "insertRawRow", "existingTemplateKeys", "insertTemplateRow", "existingMessageKeys", "insertMessageRow", "existingDataEntityKeys", "insertDataEntityRow", "existingEmailAccountKeys", "insertEmailAccountRow"];
const symbolMoves = [
  ...sm(RESTORE, RESTORE_KEYS, RESTORE_KEY_SYMS),
  ...sm(RESTORE, RESTORE_REPO, RESTORE_DB_SYMS),
  ...sm(RECEIPT, ENTITY_REPO, ["findVaultEntryByReceiptToken"]),
  ...sm(PIN_GUARD, SEC_REPO, ["hasVaultPin"]),
  ...sm(KYC_OWN, KYC_REPO, ["selectKycEntryOwnerRow"]),
];
const extractTargets = new Map();
for (const f of Object.keys(moves)) extractTargets.set(f, "whole-file");
for (const m of symbolMoves) extractTargets.set(`${m.from}#${m.name}`, m.to);

// Files whose proofs are sealed by an earlier gap and are only relocated by that gap's own re-proof.
const SEALED_BY_GAP_11 = new Set([`${APP}/health-scan.ts`, `${APP}/health-cron.ts`]);
// Encoding-only "storage" hits: Buffer/base64 handling, no filesystem/object-store/provider access.
const ENCODING_ONLY = new Set([`${V}/crypto/backup-envelope.ts#envelopeDecryptBackup`, `${APP}/snapshot/blob.ts#decryptBlob`, `${APP}/attachment/use-cases.ts#uploadAttachment`, `${APP}/attachment/use-cases.ts#downloadAttachment`, `${APP}/security/reauth.ts#verifyPasskey`]);

function listFiles() {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!p.includes("/vault/infrastructure")) walk(p); } else if (p.endsWith(".ts")) out.push(p); } };
  walk(`${V}`);
  const routes = fs.readdirSync(`${API}/routes`).filter((f) => /^(vault.*|local-accounts|kyc.*|game-entries)\.ts$/.test(f)).map((f) => `${API}/routes/${f}`);
  return [...out, ...routes].sort();
}
function classify(r) {
  const key = `${r.file}#${r.name}`;
  if (SEALED_BY_GAP_11.has(r.file)) return { disposition: "deferred-gap-11-sealed" };
  if (moves[r.file]) return { disposition: "extract-12B", target: moves[r.file] };
  if (extractTargets.has(key)) return { disposition: "extract-12B", target: extractTargets.get(key) };
  if (ENCODING_ONLY.has(key) && r.categories.length === 1 && r.categories[0] === "storage") return { disposition: "encoding-only" };
  if (r.categories.includes("job")) return { disposition: "job-wiring" };
  if (r.categories.includes("db")) return { disposition: "split-required" };
  return { disposition: "provider-event-coupling" };
}

// ── extract-method plan (12-E): every remaining direct infrastructure access -> vault/infrastructure ───────────────────────────
const INFRA = `${V}/infrastructure`;
const DB_HANDLE = `${INFRA}/db-handle.ts`, CRON_FILE = `${INFRA}/jobs/cron-scheduler.ts`, PORTS_FILE = `${INFRA}/providers/provider-ports.ts`;
const REPO_FOR = (file) => {
  const rule = [
    [/routes\/vault-attachments/, "vault-attachment-repository"], [/routes\/vault-shares/, "vault-share-repository"],
    [/application\/backup\/schedule-cron/, "vault-backup-schedule-repository"], [/entity\/activity/, "vault-activity-repository"], [/entity\/admin/, "vault-admin-repository"],
    [/entity\/analytics/, "entity-analytics-repository"], [/entity\/bulk/, "entity-bulk-repository"], [/entity\/create/, "entity-create-repository"], [/entity\/lifecycle/, "entity-lifecycle-repository"],
    [/entity\/links/, "vault-entity-link-repository"], [/entity\/receipt/, "entity-receipt-repository"], [/entity\/update/, "entity-update-repository"],
    [/application\/health/, "vault-health-repository"], [/routes\/vault\.ts/, "vault-health-repository"], [/local-account\/receipt/, "local-account-repository"],
    [/security\/reauth/, "vault-reauth-repository"], [/application\/security\//, "vault-security-repository"], [/application\/share\//, "vault-share-repository"],
    [/snapshot\/payload/, "vault-snapshot-payload-repository"], [/snapshot\/restore/, "snapshot-restore-repository"], [/application\/snapshot\//, "vault-snapshot-repository"],
    [/crypto\/backup-envelope/, "encryption-key-repository"], [/crypto\/field-encryption/, "encryption-key-repository"],
    [/security\/attachment-ownership/, "vault-attachment-repository"], [/security\/entity-ownership/, "entity-repository"], [/security\/kyc-ownership/, "kyc-repository"],
    [/security\/local-account-ownership/, "local-account-repository"], [/security\/pin-guard/, "vault-security-repository"], [/security\/share-ownership/, "vault-share-repository"], [/security\/snapshot-ownership/, "vault-snapshot-repository"],
  ].find(([re]) => re.test(file));
  return `${REPOS}/${rule ? rule[1] : path.basename(file, ".ts") + "-repository"}.ts`;
};
const PORTS = {
  sendEmail: { from: `${API}/lib/email`, alias: "sendEmailProvider" }, createNotification: { from: `${API}/routes/notifications`, alias: "createNotificationProvider" },
  sendToUser: { from: `${API}/lib/telegram`, alias: "sendTelegramToUserProvider" }, sendVaultHealthDigestEmail: { from: `${API}/lib/email`, alias: "sendVaultHealthDigestEmailProvider" },
  publishAyzenDomainEvent: { from: `${API}/lib/mega-engine/domain-events`, alias: "publishAyzenDomainEventPort" },
};
const extractMethod = {
  baselineDir: "split-baseline", relocations: [{ from: `${APP}/share/entity-types.ts`, to: `${REPOS}/share-entity-types.ts` }], allowedDbImports: ["AUTH_STEP_POLICIES"], dynamicImportPorts: [{ from: `${API}/lib/email`, to: `${INFRA}/providers/lazy-provider-ports.ts` }], dbHandleFile: DB_HANDLE, cronFile: CRON_FILE, portsFile: PORTS_FILE, ports: PORTS,
  calleeSubstitutions: { defaultDb: "db", runInTransaction: "db.transaction", scheduleCronJob: "cron.schedule", validateCronExpression: "cron.validate", ...Object.fromEntries(Object.values(PORTS).map((p, i) => [p.alias, Object.keys(PORTS)[i]])) },
  header: (repo) => `// Extracted from the Vault application layer by VLT-GAP-12 (extract-method): each function is one database call chain, verbatim.\n// Do not add business logic here — repositories only run queries.\n`,
  files: listFiles().filter((f) => fs.existsSync(path.join(process.cwd(), f))).filter((f) => !/\/vault\/(domain|api)\//.test(f) && !/(^|\/)(gap-configs)\//.test(f)).map((file) => ({ file, repo: REPO_FOR(file) })),
};

export default {
  gap: "VLT-GAP-12", dir: "reports/antas/vault/gap/VLT-GAP-12", api: API,
  differential: "scripts/antas/vault/gap/differential-vlt-gap-12.mjs",
  moves, routes: {}, symbolMoves, repositories: [RESTORE_REPO], extraOwners: [],
  repositoryExports: { [RESTORE_REPO]: RESTORE_DB_SYMS.filter((s) => s !== "DbHandle") },
  // Type-only imports (`import { type X }`) and an unrelated local `const hasVaultPin` match the declaration regex; they are not definitions.
  duplicateAllow: { RestoreTableKey: [RESTORE], RawTablePlan: [RESTORE, RESTORE_REPO], DbHandle: [RESTORE], hasVaultPin: [`${APP}/security/reauth.ts`] },
  extraSources: [RESTORE, RECEIPT, PIN_GUARD, KYC_OWN],
  extractMethod,
  infraCensus: { files: listFiles, classify },
  allowedRouteImporters: [`${API}/routes/index.ts`, `${API}/vault/api/index.ts`],
  forbiddenInRoute: [], maxRouteLines: 200,
  typecheckExtra: [`${API}/index.ts`, `${API}/routes/vault.ts`, `${APP}/index.ts`, `${V}/infrastructure/index.ts`],
  mapRows: () => [
    `| Vault snapshot section readers/re-encryptors (sections) | \`${SECTIONS_OLD}\` | \`${SECTIONS_REPO}\` | RETIRED (VLT-GAP-12); moved unchanged, old file removed |`,
    `| Vault snapshot restore identity keys / column plans | \`${RESTORE}\` | \`${RESTORE_KEYS}\` | EXTRACTED (VLT-GAP-12); bodies unchanged |`,
    `| Vault snapshot restore DB access (existing*/insert* helpers) | \`${RESTORE}\` | \`${RESTORE_REPO}\` | EXTRACTED (VLT-GAP-12); bodies unchanged |`,
    `| Vault receipt-token lookup (findVaultEntryByReceiptToken) | \`${RECEIPT}\` | \`${ENTITY_REPO}\` | EXTRACTED (VLT-GAP-12); body unchanged |`,
    `| Vault PIN presence lookup (hasVaultPin) | \`${PIN_GUARD}\` | \`${SEC_REPO}\` | EXTRACTED (VLT-GAP-12); body unchanged |`,
    `| KYC entry owner lookup (selectKycEntryOwnerRow) | \`${KYC_OWN}\` | \`${KYC_REPO}\` | EXTRACTED (VLT-GAP-12); body unchanged |`,
    `| Vault infrastructure access in application/security/crypto/routes (extract-method) | \`${API}/vault/{application,security,crypto}/**\`, \`${API}/routes/vault*.ts\` | \`${INFRA}/repositories/*\`, \`${DB_HANDLE}\`, \`${CRON_FILE}\`, \`${PORTS_FILE}\`, \`${INFRA}/providers/lazy-provider-ports.ts\` | EXTRACTED (VLT-GAP-12); every database chain / scheduler call / provider call moved verbatim, proven by split-verify inlining |`,
    `| Vault share entity-type tables and SQL helpers | \`${APP}/share/entity-types.ts\` | \`${REPOS}/share-entity-types.ts\` | RETIRED (VLT-GAP-12); moved unchanged, old file removed |`,
  ],
};
