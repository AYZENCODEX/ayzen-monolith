import crypto from "node:crypto";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function urlFor(value, allowHosts) {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("Connector URL protocol is not allowed");
  if (allowHosts?.length && !allowHosts.includes(url.hostname)) throw new Error("Connector host is not allowlisted");
  return url;
}

export function createConnectorRegistry({ fetchImpl = fetch, clock = () => Date.now(), sleepImpl = sleep } = {}) {
  const connectors = new Map();
  const cache = new Map();
  const breakers = new Map();
  return Object.freeze({
    register({ id, version = 1, baseUrl, allowedHosts = [], auth = "none", operations = {} } = {}) {
      if (typeof id !== "string" || !id.trim()) throw new Error("Connector id is required");
      if (!Number.isSafeInteger(version) || version < 1) throw new Error("Connector version is invalid");
      const base = urlFor(baseUrl, allowedHosts);
      const connector = Object.freeze({ id, version, baseUrl: base.toString().replace(/\/$/, ""), allowedHosts, auth, operations });
      connectors.set(`${id}:v${version}`, connector);
      breakers.set(`${id}:v${version}`, { failures: 0, openUntil: 0 });
      return connector;
    },
    list() { return [...connectors.values()]; },
    async execute({ connectorId, version = 1, operation, path = "/", method = "GET", body, headers = {}, idempotencyKey, timeoutMs = 10_000, attempts = 2, map = (value) => value } = {}) {
      const key = `${connectorId}:v${version}`;
      const connector = connectors.get(key);
      if (!connector) throw new Error("Connector is not registered");
      if (!connector.operations[operation]) throw new Error("Connector operation is not registered");
      const breaker = breakers.get(key);
      if (breaker.openUntil > clock()) throw Object.assign(new Error("Connector circuit is open"), { code: "CONNECTOR_CIRCUIT_OPEN" });
      const cacheKey = idempotencyKey ? `${key}:${idempotencyKey}` : null;
      if (cacheKey && cache.has(cacheKey)) return { ...cache.get(cacheKey), duplicate: true };
      let lastError;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetchImpl(new URL(path.replace(/^\/?/, "/"), `${connector.baseUrl}/`), {
            method,
            headers: { accept: "application/json", ...headers, ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal,
          });
          const raw = await response.text();
          const parsed = raw ? (() => { try { return JSON.parse(raw); } catch { return raw; } })() : null;
          if (!response.ok) throw Object.assign(new Error(`Connector returned ${response.status}`), { status: response.status, body: parsed });
          breaker.failures = 0;
          const result = { connectorId, version, operation, status: response.status, data: map(parsed), attempt, duplicate: false };
          if (cacheKey) cache.set(cacheKey, result);
          return result;
        } catch (error) {
          lastError = error;
          breaker.failures += 1;
          if (breaker.failures >= 3) breaker.openUntil = clock() + 30_000;
          if (attempt < attempts) await sleepImpl(Math.min(1_000, 50 * (2 ** (attempt - 1))));
        } finally {
          clearTimeout(timer);
        }
      }
      throw lastError;
    },
  });
}

export function createConnectorRequestId() {
  return crypto.randomUUID();
}