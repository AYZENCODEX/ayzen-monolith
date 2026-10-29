import crypto from "node:crypto";

export function createNotificationDelivery({ providers = {}, preferences = {}, quotas = {}, audit = () => {}, now = () => new Date().toISOString() } = {}) {
  const deliveries = new Map();
  const counts = new Map();
  async function deliver(input) {
    const idempotencyKey = input.idempotencyKey ?? `${input.recipient}:${input.template}:${input.channel}`;
    if (deliveries.has(idempotencyKey)) return { ...deliveries.get(idempotencyKey), replay: true };
    if (preferences[input.recipient]?.disabledChannels?.includes(input.channel)) return fail(idempotencyKey, input, "RECIPIENT_OPTED_OUT");
    const quota = quotas[`${input.app}:${input.channel}`] ?? quotas[input.channel];
    const countKey = `${input.app}:${input.recipient}:${input.channel}`;
    const count = (counts.get(countKey) ?? 0) + 1;
    if (quota?.limit !== undefined && count > quota.limit) return fail(idempotencyKey, input, "QUOTA_EXCEEDED");
    const provider = providers[input.channel];
    if (typeof provider !== "function") return fail(idempotencyKey, input, "PROVIDER_NOT_CONFIGURED");
    try {
      const result = await provider(input);
      const record = { id: crypto.randomUUID(), ...input, status: "sent", providerResult: result, deliveredAt: now() };
      counts.set(countKey, count);
      deliveries.set(idempotencyKey, record);
      audit({ action: "notification.sent", id: record.id, channel: input.channel });
      return record;
    } catch (error) {
      return fail(idempotencyKey, input, error?.code ?? "PROVIDER_FAILED");
    }
  }
  function fail(key, input, code) {
    const record = { id: crypto.randomUUID(), ...input, status: "failed", code, failedAt: now() };
    deliveries.set(key, record);
    audit({ action: "notification.failed", id: record.id, code });
    return record;
  }
  return Object.freeze({ deliver, get: (key) => deliveries.get(key), list: () => [...deliveries.values()] });
}