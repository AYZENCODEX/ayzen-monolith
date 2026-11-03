/**
 * mcp-server/origin.ts
 *
 * Origin validation for the MCP endpoint. The MCP transport spec requires
 * servers to validate Origin so a web page cannot drive a user's connector
 * through DNS rebinding or a cross-site request.
 *
 *   - no Origin header (server-to-server clients such as Claude's connector,
 *     CLIs, SDKs) → allowed; auth is the API key in the Authorization header.
 *   - AYZEN first-party origins                                → allowed.
 *   - anything else                                            → allowed only when
 *     listed in MCP_ALLOWED_ORIGINS (comma-separated exact origins, e.g.
 *     http://localhost:6274 for the MCP Inspector).
 */
import { isFirstPartyOrigin } from "../lib/api-hosts";

export function isAllowedMcpOrigin(origin: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!origin) return true;
  if (isFirstPartyOrigin(origin)) return true;
  const extra = (env.MCP_ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  return extra.includes(origin);
}
