/**
 * finance/jobs/late-fee.ts (scheduler half of lib/finance-late-fee-cron.ts, FIN-WP-7)
 * ─────────────────────────────────────────────────────────────────────────────
 * Daily schedule for the late-fee sweep (finance/fees/late-fees.ts). Moved unchanged except import paths.
 */
import cron from "node-cron";
import { logger } from "../../lib/logger";
import { logBus } from "../../lib/log-bus";
import { runFinanceLateFeeSweep } from "../fees/late-fees";

let scheduled = false;

export function startFinanceLateFeeCron(): void {
  if (scheduled) return;
  scheduled = true;

  const expr = process.env.FINANCE_LATE_FEE_CRON ?? "0 1 * * *"; // 01:00 daily
  if (!cron.validate(expr)) {
    logger.warn({ expr }, "FINANCE_LATE_FEE_CRON is not a valid cron expression — late fee auto-calc disabled");
    logBus.warn(`Late fee auto-calc cron disabled: invalid schedule "${expr}"`);
    return;
  }

  cron.schedule(expr, () => {
    runFinanceLateFeeSweep().catch((err) => {
      logger.error({ err }, "Late fee sweep failed");
      logBus.error(`Late fee sweep failed: ${err?.message ?? err}`);
    });
  });

  logBus.system(`✅ Late fee auto-calc cron scheduled ("${expr}")`);
  logger.info({ expr }, "Late fee auto-calc cron scheduled");
}
