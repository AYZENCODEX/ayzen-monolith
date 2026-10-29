/**
 * lib/process-guards.ts  (FIN F12)
 * ─────────────────────────────────────────────────────────────────────────────
 * Last-resort handler for promise rejections nobody handled (fire-and-forget
 * work, timers, queue workers). Route handlers are covered separately by
 * `express-async-errors`, which sends their rejections to `globalErrorHandler`.
 *
 * Default behaviour: log at error level with the reason and keep serving, so a
 * stray rejection in one background task cannot take the whole API down.
 * Set UNHANDLED_REJECTION_EXIT=1 to log and then exit(1) instead (for
 * deployments that prefer a supervisor restart over continuing).
 * `uncaughtException` is deliberately NOT handled here: process state is
 * unknown after one, so Node's default (print and exit) stays.
 */
import { logger } from "./logger";

const GUARD = Symbol.for("ayzen.processGuards.installed");

export function describeRejection(reason: unknown): { message: string; stack?: string } {
  if (reason instanceof Error) return { message: reason.message, stack: reason.stack };
  try {
    return { message: typeof reason === "string" ? reason : JSON.stringify(reason) };
  } catch {
    return { message: String(reason) };
  }
}

export function installProcessGuards(proc: NodeJS.Process = process): boolean {
  const flagged = proc as unknown as Record<symbol, boolean>;
  if (flagged[GUARD]) return false;
  flagged[GUARD] = true;
  proc.on("unhandledRejection", (reason: unknown) => {
    const { message, stack } = describeRejection(reason);
    logger.error({ err: message, stack }, "Unhandled promise rejection");
    if (proc.env["UNHANDLED_REJECTION_EXIT"] === "1") proc.exit(1);
  });
  return true;
}

installProcessGuards();
