import fs from "node:fs";

const policy = JSON.parse(fs.readFileSync("infrastructure/platform/backup-policy.json", "utf8"));
const required = [
  policy.restoreVerification?.isolatedTargetRequired,
  policy.restoreVerification?.recordCountsAndChecksums,
  policy.restoreVerification?.recordRtoAndRpo,
  policy.rules?.productionRestoreRequiresApproval,
  policy.rules?.runtimeIdentityCannotRestoreProduction,
  policy.rules?.deleteBeforeRestoreForbidden,
];
if (required.some((value) => value !== true)) {
  console.error("Backup/restore policy is unsafe or incomplete");
  process.exit(1);
}
console.log("Backup/restore policy check passed");