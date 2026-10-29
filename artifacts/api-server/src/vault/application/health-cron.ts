import { logger } from "../../lib/logger";
import { logBus } from "../../lib/log-bus";
import { runDailyHealthScan } from "./health-scan";
import { scheduleCronJob, validateCronExpression } from "../infrastructure/jobs/cron-scheduler";

let scheduled = false;

export function startVaultHealthCron(): void {
  if (scheduled) return; // guard against double-init (e.g. hot reload)
  scheduled = true;

  const expr = process.env.VAULT_HEALTH_SCAN_CRON ?? "0 */6 * * *";
  if (!validateCronExpression(expr)) {
    logger.warn({ expr }, "VAULT_HEALTH_SCAN_CRON is not a valid cron expression — health scan cron disabled");
    logBus.warn(`Vault health scan cron disabled: invalid schedule "${expr}"`);
    return;
  }

  scheduleCronJob(expr, () => {
    runDailyHealthScan().catch((err) => {
      logger.error({ err }, "Daily vault health scan failed");
      logBus.error(`Vault health scan failed: ${err?.message ?? err}`);
    });
  });

  logBus.system(`✅ Vault health scan cron scheduled ("${expr}")`);
  logger.info({ expr }, "Vault health scan cron scheduled");
}
