import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const STATUSES = new Set(["open", "acknowledged", "resolved"]);

function redact(value, depth = 0) {
  if (depth > 5) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (!value || typeof value !== "object") return typeof value === "string" ? value.slice(0, 2_000) : value;
  return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [
    key,
    /secret|token|password|private|authorization|cookie|credential/i.test(key) ? "[redacted]" : redact(item, depth + 1),
  ]));
}

function validateAlert(input = {}) {
  if (typeof input.eventType !== "string" || !input.eventType.trim()) throw new Error("Alert eventType is required");
  if (typeof input.service !== "string" || !input.service.trim()) throw new Error("Alert service is required");
  const severity = input.severity ?? "medium";
  if (!SEVERITIES.has(severity)) throw new Error("Alert severity is invalid");
  return {
    id: input.id ?? crypto.randomUUID(),
    eventType: input.eventType.trim(),
    service: input.service.trim(),
    severity,
    resource: input.resource ? String(input.resource).slice(0, 256) : undefined,
    environment: input.environment ? String(input.environment).slice(0, 64) : "unknown",
    tenant: redact(input.tenant),
    summary: String(input.summary ?? input.eventType).slice(0, 500),
    evidence: redact(input.evidence ?? {}),
    createdAt: input.createdAt ?? new Date().toISOString(),
    status: "open",
    notifications: [],
  };
}

function defaultKey(alert, keyFields) {
  return keyFields.map((field) => `${field}=${alert[field] ?? ""}`).join("|");
}

export function createAlertOrchestrator({
  filePath,
  routing = {},
  now = () => Date.now(),
  notificationSink = async () => {},
} = {}) {
  const alerts = [];
  const lastByKey = new Map();
  const cooldownMs = Math.max(0, Number(routing.deduplication?.cooldownSeconds ?? 300) * 1_000);
  const groupWindowMs = Math.max(0, Number(routing.deduplication?.groupWindowSeconds ?? 60) * 1_000);
  const keyFields = Array.isArray(routing.deduplication?.keyFields)
    ? routing.deduplication.keyFields
    : ["eventType", "service", "resource", "environment"];
  const suppressedEvents = new Set(routing.maintenanceSuppresses ?? []);

  if (filePath) {
    try {
      const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (Array.isArray(saved?.alerts)) alerts.push(...saved.alerts);
      for (const alert of alerts) {
        if (alert.dedupeKey) lastByKey.set(alert.dedupeKey, Date.parse(alert.createdAt) || 0);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  function persist() {
    if (!filePath) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, alerts }, null, 2)}\n`);
    fs.renameSync(temporary, filePath);
  }

  async function emit(alert, channels) {
    const notifications = [];
    for (const channel of channels) {
      const notification = { channel, sentAt: new Date(now()).toISOString() };
      notifications.push(notification);
      await notificationSink({ alert, channel });
    }
    alert.notifications.push(...notifications);
  }

  return Object.freeze({
    async create(input = {}) {
      const alert = validateAlert(input);
      if (suppressedEvents.has(alert.eventType) && input.maintenance === true) {
        return { created: false, suppressed: true, reason: "MAINTENANCE_SUPPRESSION", alert: null };
      }
      const key = defaultKey(alert, keyFields);
      const previousAt = lastByKey.get(key);
      if (previousAt !== undefined && now() - previousAt < cooldownMs) {
        return { created: false, deduplicated: true, reason: "COOLDOWN", alert: alerts.find((item) => item.dedupeKey === key) ?? null };
      }
      const severityPolicy = routing.severity?.[alert.severity] ?? {};
      alert.dedupeKey = key;
      alert.groupUntil = new Date(now() + groupWindowMs).toISOString();
      alert.escalateAt = severityPolicy.escalateAfterSeconds > 0
        ? new Date(now() + severityPolicy.escalateAfterSeconds * 1_000).toISOString()
        : null;
      alert.ackRequired = severityPolicy.ackRequired === true;
      alerts.push(alert);
      lastByKey.set(key, now());
      await emit(alert, severityPolicy.channels ?? []);
      persist();
      return { created: true, suppressed: false, alert: { ...alert, notifications: [...alert.notifications] } };
    },
    acknowledge(id, actor) {
      const alert = alerts.find((item) => item.id === id);
      if (!alert) return { updated: false, code: "ALERT_NOT_FOUND" };
      if (!actor) throw new Error("Alert acknowledgement actor is required");
      alert.status = "acknowledged";
      alert.acknowledgedAt = new Date(now()).toISOString();
      alert.acknowledgedBy = String(actor).slice(0, 256);
      persist();
      return { updated: true, alert: { ...alert } };
    },
    resolve(id, actor, resolution = {}) {
      const alert = alerts.find((item) => item.id === id);
      if (!alert) return { updated: false, code: "ALERT_NOT_FOUND" };
      if (!actor) throw new Error("Alert resolution actor is required");
      alert.status = "resolved";
      alert.resolvedAt = new Date(now()).toISOString();
      alert.resolvedBy = String(actor).slice(0, 256);
      alert.resolution = redact(resolution);
      persist();
      return { updated: true, alert: { ...alert } };
    },
    list({ status, severity, service, tenantId } = {}) {
      if (status && !STATUSES.has(status)) throw new Error("Alert status is invalid");
      return alerts.filter((alert) =>
        (!status || alert.status === status)
        && (!severity || alert.severity === severity)
        && (!service || alert.service === service)
        && (!tenantId || alert.tenant?.organizationId === tenantId || alert.tenant?.workspaceId === tenantId),
      ).map((alert) => ({ ...alert, notifications: [...alert.notifications] }));
    },
    escalationDue(at = now()) {
      return alerts.filter((alert) => alert.status !== "resolved" && alert.escalateAt && Date.parse(alert.escalateAt) <= at)
        .map((alert) => ({ ...alert }));
    },
  });
}