import "./lib/process-guards"; // FIN F12
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./lib/logger";
import { logBus } from "./lib/log-bus";
import { startMegaEngine, stopMegaEngine } from "./lib/mega-engine";

async function start(): Promise<void> {
  await db.execute(sql`SELECT 1`);
  await startMegaEngine();
  logger.info({ service: "ayzen-worker" }, "Worker runtime started");
  logBus.system("AYZEN worker runtime started");
}

start().catch((err) => {
  logger.error({ err }, "Worker runtime failed to start");
  process.exitCode = 1;
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "Worker runtime stopping");
  await stopMegaEngine();
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));