/**
 * routes/vault-backup-schedule.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 15c — Automatic Vault Backups: config endpoints for the per-user
 * vault_backup_schedules row, a manual "Run Now" trigger, the delivery-history
 * list and the caller's own backup audit log.
 *
 * VLT-GAP-08: every handler below is a thin delegating adapter. Validation
 * rules, defaults, SSRF-guarded webhook handling, nextRunAt recomputation and
 * audit events live, unchanged, in vault/application/backup/schedule.ts (the
 * sweeping cron is vault/application/backup/schedule-cron.ts); DB access is in
 * vault/infrastructure/repositories/vault-backup-repository.ts.
 */
import { Router } from "express";
import express from "express";
import { requireAuth, getRequestUserId } from "../middlewares/auth";
import { sensitiveWriteLimiter } from "../middlewares/security";
import { getSchedule, saveSchedule, runScheduleNow, listDeliveries, getOwnAuditLog } from "../vault/application/backup/schedule";

const router = Router();

// ─── GET /vault/backup/schedule ─────────────────────────────────────────────
router.get("/vault/backup/schedule", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const out = await getSchedule(userId);
  res.status(out.status).json(out.body);
});

// ─── PUT /vault/backup/schedule ─────────────────────────────────────────────
router.put("/vault/backup/schedule", requireAuth, express.json(), sensitiveWriteLimiter, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const out = await saveSchedule(userId, req.body, req);
  res.status(out.status).json(out.body);
});

// ─── POST /vault/backup/schedule/run-now ───────────────────────────────────
router.post("/vault/backup/schedule/run-now", requireAuth, sensitiveWriteLimiter, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const out = await runScheduleNow(userId);
  res.status(out.status).json(out.body);
});

// ─── GET /vault/backup/deliveries ───────────────────────────────────────────
router.get("/vault/backup/deliveries", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const out = await listDeliveries(userId);
  res.status(out.status).json(out.body);
});

// ─── GET /vault/backup/audit-log ────────────────────────────────────────────
router.get("/vault/backup/audit-log", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const out = await getOwnAuditLog(userId, req.query.limit);
  res.status(out.status).json(out.body);
});

export default router;
