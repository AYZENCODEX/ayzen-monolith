import cron from "node-cron";

/** `cron.validate` / `cron.schedule` — the only way Vault application code touches the scheduler (VLT-GAP-12). */
export const validateCronExpression = ((...args: Parameters<typeof cron.validate>) => cron.validate(...args)) as typeof cron.validate;
export const scheduleCronJob = ((...args: Parameters<typeof cron.schedule>) => cron.schedule(...args)) as typeof cron.schedule;
