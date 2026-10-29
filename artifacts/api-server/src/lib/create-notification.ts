import { db, notificationsTable } from "@workspace/db";
import { broadcastToUser } from "./event-hub";

/** Moved verbatim out of routes/notifications.ts (VLT-GAP-14-B) so Vault infrastructure does not import a route module. */
export async function createNotification(
  userId: number, type: string, title: string, message: string, data?: Record<string, unknown>
) {
  try {
    const [notif] = await db.insert(notificationsTable).values({
      userId, type, title, message, isRead: false,
      data: data ? JSON.stringify(data) : undefined,
    }).returning();
    broadcastToUser(userId, "notification", { id: notif.id, type, title, message });
  } catch {}
}
