import type { Request } from "express";
import { db, financeInvoiceEventsTable } from "@workspace/db";

// Append-only invoice evidence trail. Moved unchanged from lib/finance-invoice.ts (FIN-WP-6a). The only edit
// is a type: the request parameter is the three fields the code actually reads (`ip`, `socket`, `headers`)
// instead of the whole Express Request, so use cases and tests do not need an Express request.

export type InvoiceEventRequest = Pick<Request, "ip" | "socket" | "headers">;

/** Best-effort append-only trail row — never throws, so a logging failure never blocks the action it's logging. */
export async function logInvoiceEvent(
  invoiceId: number,
  eventType: string,
  req?: InvoiceEventRequest,
  meta?: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(financeInvoiceEventsTable).values({
      invoiceId,
      eventType,
      meta: meta ? JSON.stringify(meta) : null,
      ipAddress: req ? getClientIpLocal(req) : null,
      userAgent: req ? ((req.headers["user-agent"] as string) || null) : null,
    });
  } catch { /* evidence logging is best-effort, never blocking */ }
}

// Local copy of the same IP-extraction logic as lib/login-security.ts's
// getClientIp — kept here rather than importing across modules that aren't
// otherwise related, so this file has no dependency on the login/step-up
// stack.
export function getClientIpLocal(req: InvoiceEventRequest): string {
  return (req.ip || (req.socket && req.socket.remoteAddress) || "unknown").replace(/^::ffff:/, "");
}
