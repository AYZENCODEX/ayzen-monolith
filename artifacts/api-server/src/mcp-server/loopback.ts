/**
 * mcp-server/loopback.ts
 *
 * ApiCaller that reaches this same server's REST API over loopback HTTP,
 * forwarding the caller's own Authorization header. Going through HTTP (not a
 * direct function call) is deliberate: auth, API-key scope gate, ownership
 * checks and credit metering all run exactly as for any other client, and the
 * MCP layer cannot drift from the REST routes.
 *
 *   MCP_INTERNAL_API_BASE   override the loopback base (default http://127.0.0.1:$PORT/api)
 */
import type { ApiCaller } from "./tools";

export const MCP_API_TIMEOUT_MS = 15_000;

function internalBase(env: NodeJS.ProcessEnv): string {
  const explicit = env.MCP_INTERNAL_API_BASE?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const port = env.AYZEN_API_PORT ?? env.PORT ?? "8080";
  return `http://127.0.0.1:${port}/api`;
}

export function makeLoopbackCaller(
  authHeader: string,
  clientIp: string | undefined,
  opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): ApiCaller {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = internalBase(opts.env ?? process.env);
  return async (method, path, body) => {
    const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: authHeader };
    // The app trusts one proxy hop, so this makes the global IP limiter see the real caller
    // instead of lumping every MCP user into 127.0.0.1.
    if (clientIp) headers["X-Forwarded-For"] = clientIp;
    const r = await doFetch(`${base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(MCP_API_TIMEOUT_MS),
    });
    const text = await r.text();
    let data: unknown;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!r.ok) {
      const message = data && typeof data === "object" && "error" in data && typeof (data as { error: unknown }).error === "string"
        ? (data as { error: string }).error
        : `API error ${r.status}`;
      throw new Error(message);
    }
    return data;
  };
}
