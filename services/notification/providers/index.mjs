import crypto from "node:crypto";

export function createProviderRegistry({ providers = {} } = {}) {
  const registry = new Map(Object.entries(providers));
  return Object.freeze({
    register(name, provider) {
      if (typeof name !== "string" || typeof provider?.send !== "function") throw new Error("Notification provider must expose send()");
      registry.set(name, provider);
      return provider;
    },
    get: (name) => registry.get(name),
    list: () => [...registry.keys()],
  });
}

export function createHttpProvider({ channel, urlEnv, fetchImpl = fetch, timeoutMs = 5_000, maxConcurrency = 20 } = {}) {
  if (!channel || !urlEnv) throw new Error("HTTP notification provider requires channel and urlEnv");
  let active = 0;
  return Object.freeze({
    async send({ notification, actor, tenant, requestId } = {}) {
      const url = process.env[urlEnv];
      if (!url) {
        throw Object.assign(new Error(`Notification provider ${channel} is not configured`), {
          code: "NOTIFICATION_PROVIDER_NOT_CONFIGURED",
        });
      }
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        throw Object.assign(new Error(`Notification provider ${channel} has an invalid URL`), {
          code: "NOTIFICATION_PROVIDER_INVALID_URL",
        });
      }
      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw Object.assign(new Error(`Notification provider ${channel} requires HTTP(S)`), {
          code: "NOTIFICATION_PROVIDER_INVALID_URL",
        });
      }
      if (active >= maxConcurrency) {
        throw Object.assign(new Error(`Notification provider ${channel} bulkhead is full`), { code: "NOTIFICATION_PROVIDER_BULKHEAD_FULL" });
      }
      const secret = process.env[`${urlEnv}_SECRET`];
      if (["production", "staging"].includes(String(process.env.NODE_ENV ?? "").toLowerCase()) && !secret) {
        throw Object.assign(new Error(`Notification provider ${channel} signing secret is not configured`), { code: "NOTIFICATION_PROVIDER_SECRET_MISSING" });
      }
      const body = JSON.stringify({ notification, actor, tenant });
      const timestamp = String(Date.now());
      const signature = secret ? crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex") : undefined;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      active += 1;
      try {
        const response = await fetchImpl(parsed, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-request-id": requestId ?? "",
            ...(signature ? { "x-ayzen-provider-timestamp": timestamp, "x-ayzen-provider-signature": signature } : {}),
          },
          body,
          signal: controller.signal,
        });
        if (!response.ok) {
          throw Object.assign(new Error(`Notification provider ${channel} returned HTTP ${response.status}`), {
            code: "NOTIFICATION_PROVIDER_FAILED",
            status: response.status,
          });
        }
        return { delivered: true, provider: channel };
      } catch (error) {
        if (error?.name === "AbortError") throw Object.assign(new Error(`Notification provider ${channel} timed out`), { code: "NOTIFICATION_PROVIDER_TIMEOUT" });
        throw error;
      } finally {
        clearTimeout(timeout);
        active -= 1;
      }
    },
  });
}