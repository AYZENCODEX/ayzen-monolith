/**
 * lib/api-hosts.ts
 *
 * Phase 2 — dedicated API host (api.ayzen.tech).
 *
 * The same Express app still serves every *.ayzen.tech host. What changes on
 * an API host is what it does NOT do: it never serves the SPA (index.html),
 * never 308-redirects to module hosts, and answers unknown non-/api paths
 * with a JSON 404 instead of the web app shell.
 *
 *   API_HOSTS  comma-separated hostnames treated as API hosts
 *              (default: api.ayzen.tech)
 *   MCP_HOSTS  comma-separated hostnames that serve the MCP endpoint and are
 *              treated as API hosts too (default: mcp.ayzen.tech)
 *
 * Also the single definition of "first-party origin" used by CORS.
 * Dependency-free so unit tests and scripts can import it directly.
 */

export const DEFAULT_API_HOST = "api.ayzen.tech";

export function getApiHosts(): string[] {
  const raw = process.env.API_HOSTS?.trim();
  const list = (raw ? raw : DEFAULT_API_HOST)
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return list.length > 0 ? list : [DEFAULT_API_HOST];
}

export const DEFAULT_MCP_HOST = "mcp.ayzen.tech";

/** MCP_HOSTS: comma-separated hostnames that serve the MCP endpoint (default: mcp.ayzen.tech). */
export function getMcpHosts(): string[] {
  const raw = process.env.MCP_HOSTS?.trim();
  const list = (raw ? raw : DEFAULT_MCP_HOST)
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return list.length > 0 ? list : [DEFAULT_MCP_HOST];
}

export function isMcpHost(hostname: string | undefined | null): boolean {
  if (!hostname) return false;
  const host = hostname.trim().toLowerCase().split(":")[0];
  return getMcpHosts().includes(host);
}

/** API hosts and MCP hosts never serve the SPA: real routes only, JSON 404 otherwise. */
export function isApiHost(hostname: string | undefined | null): boolean {
  if (!hostname) return false;
  const host = hostname.trim().toLowerCase().split(":")[0];
  return getApiHosts().includes(host) || getMcpHosts().includes(host);
}

// https://ayzen.tech and https://<anything>.ayzen.tech (single label, no wildcard
// across other registrable domains: "ayzen.tech.evil.com" and "evilayzen.tech"
// do not match).
const FIRST_PARTY_HTTPS = /^https:\/\/(?:[a-z0-9-]+\.)?ayzen\.tech$/;
const LOCAL_DEV = /^http:\/\/[a-z0-9-]+\.localhost$/;

/** True for AYZEN's own origins (apex + one-level subdomains, plus *.localhost for dev). */
export function isFirstPartyOrigin(origin: string): boolean {
  return FIRST_PARTY_HTTPS.test(origin) || LOCAL_DEV.test(origin);
}

/** Production-only variant: no localhost. */
export function isFirstPartyProdOrigin(origin: string): boolean {
  return FIRST_PARTY_HTTPS.test(origin);
}
