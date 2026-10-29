import type { VaultRequest } from "../../security/request-context";
import crypto from "crypto";
import { computeNextRunAt, runVaultBackupSchedule } from "./schedule-cron";
import { assertPublicHttpsUrl } from "../../../lib/ssrf-guard";
import { logBackupAudit, redactUrl, listOwnBackupAuditLog } from "../../infrastructure/backup/audit";
import {
  getScheduleRow, insertScheduleRow, updateScheduleRow, listDeliveryRows,
} from "../../infrastructure/repositories/vault-backup-repository";

export interface VaultBackupResult { status: number; body: unknown }

/**
 * Automatic Vault Backups (Feature 15c) config use cases. Moved unchanged from
 * routes/vault-backup-schedule.ts (VLT-GAP-08): validation rules, defaults,
 * nextRunAt recomputation, webhook-secret handling and audit events are
 * identical. The cron that sweeps these rows is ./schedule-cron.
 */

const FREQUENCIES = ["daily", "weekly", "monthly"] as const;
// Feature 15l: "google_drive"/"dropbox" require a connection already made via
// the cloud-connection use cases — checked at run time (cron/"Run Now"), not
// here, so saving the schedule config never depends on connect order.
const DESTINATIONS = ["store", "email", "webhook", "google_drive", "dropbox"] as const;

/**
 * GET /vault/backup/schedule — the caller's schedule config, or sane defaults
 * (enabled: false) if they've never configured one.
 */
export async function getSchedule(userId: number): Promise<VaultBackupResult> {
  const row = await getScheduleRow(userId);
  if (!row) {
    return {
      status: 200,
      body: {
        enabled: false, frequency: "weekly", dayOfWeek: 0, dayOfMonth: 1, hourOfDay: 3,
        includeAttachments: false, destination: "store", destinationEmail: null, webhookUrl: null,
        lastRunAt: null, lastRunStatus: null, lastRunError: null, nextRunAt: null,
      },
    };
  }
  const { webhookSecret, ...safe } = row;
  return { status: 200, body: { ...safe, hasWebhookSecret: !!webhookSecret } };
}

/**
 * PUT /vault/backup/schedule — upserts the caller's schedule config.
 * Recomputes nextRunAt whenever the timing fields change or the schedule
 * transitions enabled: false -> true.
 */
export async function saveSchedule(userId: number, rawBody: unknown, req: VaultRequest): Promise<VaultBackupResult> {
  const body: any = rawBody ?? {};
  const enabled = !!body.enabled;
  const frequency = FREQUENCIES.includes(body.frequency) ? body.frequency : "weekly";
  const dayOfWeek = Number.isInteger(body.dayOfWeek) ? Math.min(Math.max(body.dayOfWeek, 0), 6) : 0;
  const dayOfMonth = Number.isInteger(body.dayOfMonth) ? Math.min(Math.max(body.dayOfMonth, 1), 28) : 1;
  const hourOfDay = Number.isInteger(body.hourOfDay) ? Math.min(Math.max(body.hourOfDay, 0), 23) : 3;
  const includeAttachments = !!body.includeAttachments;
  const destination = DESTINATIONS.includes(body.destination) ? body.destination : "store";
  const destinationEmail = typeof body.destinationEmail === "string" && body.destinationEmail.trim() ? body.destinationEmail.trim() : null;
  const webhookUrl = typeof body.webhookUrl === "string" && body.webhookUrl.trim() ? body.webhookUrl.trim() : null;

  // Vault Backup hardening, Round 5 — SSRF guard (see lib/ssrf-guard.ts). A
  // webhook URL is checked here for immediate feedback, and — the check that
  // actually matters — again by the delivery owner right before every
  // scheduled send, since DNS can change after this save.
  if (destination === "webhook" && webhookUrl) {
    try {
      await assertPublicHttpsUrl(webhookUrl);
    } catch (err: any) {
      return { status: 400, body: { error: err?.message ?? "webhookUrl isn't allowed" } };
    }
  }
  if (destination === "email" && destinationEmail && !/.+@.+\..+/.test(destinationEmail)) {
    return { status: 400, body: { error: "destinationEmail doesn't look like a valid email address" } };
  }

  const existing = await getScheduleRow(userId);

  // Keep the existing webhook secret unless the caller is (re)configuring a
  // webhook destination for the first time — generated once, never shown back
  // in full (see getSchedule's hasWebhookSecret flag instead).
  let webhookSecret = existing?.webhookSecret ?? null;
  if (destination === "webhook" && !webhookSecret) {
    webhookSecret = crypto.randomBytes(24).toString("hex");
  }

  const timingChanged = !existing
    || existing.frequency !== frequency || existing.dayOfWeek !== dayOfWeek
    || existing.dayOfMonth !== dayOfMonth || existing.hourOfDay !== hourOfDay
    || (!existing.enabled && enabled);
  const nextRunAt = enabled ? (timingChanged ? computeNextRunAt({ frequency, dayOfWeek, dayOfMonth, hourOfDay }, new Date()) : existing?.nextRunAt) : null;

  const values = {
    userId, enabled, frequency, dayOfWeek, dayOfMonth, hourOfDay, includeAttachments,
    destination, destinationEmail, webhookUrl, webhookSecret, nextRunAt, updatedAt: new Date(),
  };

  if (existing) {
    await updateScheduleRow(existing.id, values);
  } else {
    await insertScheduleRow(values);
  }

  // Vault Backup hardening, Round 6 — a schedule's off-vault destination is the
  // exact surface Round 5's SSRF guard protects; log every time it changes. The
  // URL is redacted (host+path only, see redactUrl()) — a webhook URL can carry
  // an auth token in its query string, which never belongs in a log.
  const destinationChanged = !existing || existing.destination !== destination;
  const webhookChanged = destination === "webhook" && (!existing || existing.webhookUrl !== webhookUrl);
  if (destinationChanged) {
    await logBackupAudit({
      ownerUserId: userId, eventType: "schedule_destination_changed", req,
      detail: { from: existing?.destination ?? null, to: destination },
    });
  }
  if (webhookChanged) {
    await logBackupAudit({
      ownerUserId: userId, eventType: "schedule_webhook_changed", req,
      detail: { webhookUrl: redactUrl(webhookUrl) },
    });
  }

  return { status: 200, body: { ok: true, nextRunAt } };
}

/**
 * POST /vault/backup/schedule/run-now — runs the caller's configured schedule
 * immediately (must already have one saved, though it needn't be `enabled`).
 */
export async function runScheduleNow(userId: number): Promise<VaultBackupResult> {
  const row = await getScheduleRow(userId);
  if (!row) return { status: 404, body: { error: "No backup schedule configured yet — set one up first." } };

  const result = await runVaultBackupSchedule(row);
  if (!result.ok) return { status: 502, body: { ok: false, error: result.error } };
  return { status: 200, body: { ok: true, snapshotId: result.snapshotId } };
}

/** GET /vault/backup/deliveries — recent off-vault delivery attempts, newest first. */
export async function listDeliveries(userId: number): Promise<VaultBackupResult> {
  const rows = await listDeliveryRows(userId);
  return { status: 200, body: { deliveries: rows } };
}

/**
 * GET /vault/backup/audit-log — the caller's own backup-security history.
 * Deliberately excludes namespace-wide key-rotation events (admin-only feed).
 */
export async function getOwnAuditLog(userId: number, limitQuery: unknown): Promise<VaultBackupResult> {
  const limit = limitQuery ? Number(limitQuery) : undefined;
  const rows = await listOwnBackupAuditLog(userId, limit && Number.isFinite(limit) ? limit : undefined);
  return { status: 200, body: { events: rows } };
}
