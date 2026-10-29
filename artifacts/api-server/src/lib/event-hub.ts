import type { Response } from "express";

/**
 * SSE client registry + broadcast helpers. Moved verbatim out of routes/events.ts
 * (VLT-GAP-14-B) so Vault infrastructure can publish events without importing a
 * route module. routes/events.ts re-exports the public functions and keeps the
 * HTTP endpoints; there is still exactly one `clients` / `projectPresence` instance.
 */

export interface SSEClient {
  id: string;
  userId: number;
  res: Response;
  connectedAt: number;
  projectId?: number;
}

export const clients: SSEClient[] = [];

// ─── Presence: projectId → Set of userIds ─────────────────────────────────────
export const projectPresence = new Map<number, Set<number>>();

// ─── Flush-aware write — critical for Replit deployment proxy ─────────────────
export function sseWrite(res: Response, event: string, data: Record<string, unknown>): boolean {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    // Force flush through Nginx / Replit's mTLS proxy — without this, events
    // are buffered and only delivered in bursts or after connection closes
    if (typeof (res as any).flush === "function") (res as any).flush();
    return true;
  } catch {
    return false;
  }
}

export function sseHeartbeat(res: Response): boolean {
  try {
    res.write(`: heartbeat\n\n`);
    if (typeof (res as any).flush === "function") (res as any).flush();
    return true;
  } catch {
    return false;
  }
}

// ─── Broadcast helpers ────────────────────────────────────────────────────────
export function broadcastEvent(event: string, data: Record<string, unknown> = {}) {
  const payload = { ...data, ts: Date.now() };
  for (let i = clients.length - 1; i >= 0; i--) {
    if (!sseWrite(clients[i].res, event, payload)) clients.splice(i, 1);
  }
}

export function broadcastToProject(projectId: number, event: string, data: Record<string, unknown> = {}) {
  const payload = { ...data, projectId, ts: Date.now() };
  for (let i = clients.length - 1; i >= 0; i--) {
    if (clients[i].projectId !== projectId) continue;
    if (!sseWrite(clients[i].res, event, payload)) clients.splice(i, 1);
  }
}

export function broadcastToUser(userId: number, event: string, data: Record<string, unknown> = {}) {
  const payload = { ...data, ts: Date.now() };
  for (let i = clients.length - 1; i >= 0; i--) {
    if (clients[i].userId !== userId) continue;
    if (!sseWrite(clients[i].res, event, payload)) clients.splice(i, 1);
  }
}

export function getActiveConnectionCount() { return clients.length; }
export function getProjectPresence(projectId: number) { return [...(projectPresence.get(projectId) ?? [])]; }
export function getAllProjectPresence() {
  const result: Record<number, number> = {};
  projectPresence.forEach((users, pid) => { result[pid] = users.size; });
  return result;
}
