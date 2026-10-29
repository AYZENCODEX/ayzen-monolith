import net from "node:net";

const SENSITIVE = /authorization|cookie|password|secret|token|private.?key|plaintext|credential/i;

export function redact(value, depth = 0) {
  if (depth > 6) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redact(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, SENSITIVE.test(key) ? "[REDACTED]" : redact(child, depth + 1)]));
}

export function securityHeaders({ production = process.env.NODE_ENV === "production" } = {}) {
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    ...(production ? { "strict-transport-security": "max-age=31536000; includeSubDomains" } : {}),
  };
}

export function allowedOrigin(origin, configured = process.env.CORS_ORIGIN) {
  if (!origin) return undefined;
  if (!configured || configured === "*") return configured === "*" ? "*" : undefined;
  const allowed = configured.split(",").map((value) => value.trim()).filter(Boolean);
  return allowed.includes(origin) ? origin : undefined;
}

export function assertSafeUpstreamUrl(value, { allowedHosts = process.env.SERVICE_URL_ALLOWLIST, production = process.env.NODE_ENV === "production" } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Service URL is invalid"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Service URL protocol is not allowed");
  const hosts = allowedHosts?.split(",").map((host) => host.trim()).filter(Boolean);
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(url.hostname) || net.isIP(url.hostname) === 0 && url.hostname.endsWith(".local");
  if (production && url.protocol !== "https:" && !isLocal) throw new Error("Production service URLs must use HTTPS");
  if (hosts?.length && !hosts.includes(url.hostname)) throw new Error("Service URL host is not allowlisted");
  return url;
}

export function tenantMatches(resource = {}, scope = {}) {
  return (!scope.organizationId || !resource.organizationId || scope.organizationId === resource.organizationId)
    && (!scope.workspaceId || !resource.workspaceId || scope.workspaceId === resource.workspaceId);
}