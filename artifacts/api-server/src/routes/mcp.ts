/**
 * routes/mcp.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN's MCP (Model Context Protocol) server — Streamable HTTP transport,
 * stateless. Phase 8 rewrite of the original minimal wrapper.
 *
 *   POST /mcp   JSON-RPC 2.0 request / notification / batch
 *   GET  /mcp   405 (this server offers no server-initiated SSE stream)
 *   DELETE /mcp 405 (no sessions to terminate)
 *
 * Reachable at (same router, mounted twice — see app.ts and routes/index.ts):
 *   https://api.ayzen.tech/mcp   and   https://mcp.ayzen.tech/mcp    (API/MCP hosts)
 *   https://<origin>/api/mcp                                          (legacy path, kept)
 *
 * Stateless on purpose: no Mcp-Session-Id is issued, which the spec allows.
 * The app runs on autoscaled instances, so in-memory sessions would 404 on the
 * next request that lands elsewhere. Every request carries its own credentials.
 *
 * Auth: an AYZEN API key (`ayzn_live_…`, Settings → Developer → API Keys) in
 * `Authorization: Bearer`. Browser sessions and cookies are refused so a web
 * page can never drive this endpoint on a signed-in user's behalf. OAuth is not
 * offered: AYZEN's OIDC provider has no dynamic client registration, so
 * advertising it would send MCP clients into an authorization flow that cannot
 * complete. Scoped keys need the `mcp` scope plus each tool's module scope
 * (lib/api-scopes.ts); tool calls loop back through the normal REST stack, so
 * the scope gate, ownership checks and credit metering all apply.
 *
 * Logic lives in src/mcp-server/*; this file is only HTTP wiring.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { looksLikeApiKey } from "../lib/api-key-crypto";
import { authenticateAccessToken } from "../lib/identity-service";
import { logger } from "../lib/logger";
import { isAllowedMcpOrigin } from "../mcp-server/origin";
import { FixedWindowLimiter, mcpRateLimitPerMinute } from "../mcp-server/rate-limit";
import { makeLoopbackCaller } from "../mcp-server/loopback";
import { handleRpcMessage, isSupportedProtocolVersion, RPC_ERROR, type JsonRpcResponse } from "../mcp-server/protocol";
import type { McpPrincipal } from "../mcp-server/tools";

const router = Router();
const limiter = new FixedWindowLimiter(mcpRateLimitPerMinute());
const MAX_BATCH = 20;

const rpcError = (code: number, message: string): JsonRpcResponse => ({ jsonrpc: "2.0", id: null, error: { code, message } });

/** Authenticated caller, handed from requireMcpApiKey() to the handler via res.locals. */
interface McpLocals { principal: McpPrincipal; authHeader: string }

async function requireMcpApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  res.setHeader("Cache-Control", "no-store");

  if (!isAllowedMcpOrigin(req.headers.origin)) {
    res.status(403).json(rpcError(-32000, "Origin not allowed"));
    return;
  }

  const version = req.headers["mcp-protocol-version"];
  if (typeof version === "string" && version && !isSupportedProtocolVersion(version)) {
    res.status(400).json(rpcError(-32000, `Unsupported MCP-Protocol-Version: ${version}`));
    return;
  }

  // API key from the Authorization header only — never the session cookie.
  const authHeader = req.headers.authorization;
  const token = typeof authHeader === "string" && /^Bearer\s+/i.test(authHeader) ? authHeader.replace(/^Bearer\s+/i, "").trim() : "";
  if (!token || !looksLikeApiKey(token)) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="ayzen-mcp"');
    res.status(401).json(rpcError(-32001, "Unauthorized: send an AYZEN API key as 'Authorization: Bearer ayzn_live_…'."));
    return;
  }
  const user = await authenticateAccessToken(token);
  if (!user || user.authType !== "apikey") {
    res.setHeader("WWW-Authenticate", 'Bearer realm="ayzen-mcp", error="invalid_token"');
    res.status(401).json(rpcError(-32001, "Unauthorized: invalid or revoked API key."));
    return;
  }

  const principal: McpPrincipal = {
    userId: user.userId,
    keyType: user.keyType === "scoped" ? "scoped" : "full",
    scopes: user.scopes ?? [],
  };
  // The REST scope gate enforces this on /api/mcp; checking here keeps /mcp (outside /api) equally strict.
  if (principal.keyType === "scoped" && !principal.scopes.includes("mcp")) {
    res.status(403).json(rpcError(-32002, 'This API key needs the "mcp" scope to use the MCP server.'));
    return;
  }

  const rl = limiter.hit(`u:${principal.userId}`);
  res.setHeader("RateLimit-Limit", String(rl.limit));
  res.setHeader("RateLimit-Remaining", String(rl.remaining));
  if (!rl.allowed) {
    res.setHeader("Retry-After", String(rl.retryAfterSec));
    res.status(429).json(rpcError(-32003, "Rate limit exceeded. Slow down and retry."));
    return;
  }

  res.locals.mcp = { principal, authHeader: authHeader as string } satisfies McpLocals;
  next();
}

router.post("/mcp", (req, res, next) => { requireMcpApiKey(req, res, next).catch(next); }, async (req, res): Promise<void> => {
  const { principal, authHeader } = res.locals.mcp as McpLocals;
  const ctx = {
    principal,
    callApi: makeLoopbackCaller(authHeader, req.ip),
    audit: (entry: { tool: string; ok: boolean; durationMs: number; reason?: string }) => {
      // Metadata only — argument values can hold secrets and are never logged.
      logger.info({ event: "mcp.tool_call", userId: principal.userId, keyType: principal.keyType, ...entry }, "mcp tool call");
    },
  };

  const body: unknown = req.body;
  if (Array.isArray(body)) {
    if (body.length === 0 || body.length > MAX_BATCH) {
      res.status(400).json(rpcError(RPC_ERROR.INVALID_REQUEST, `Batch must contain 1–${MAX_BATCH} messages`));
      return;
    }
    const out = (await Promise.all(body.map((m) => handleRpcMessage(m, ctx)))).filter((r): r is JsonRpcResponse => r !== null);
    if (out.length === 0) { res.status(202).end(); return; }
    res.json(out);
    return;
  }

  const response = await handleRpcMessage(body, ctx);
  if (response === null) { res.status(202).end(); return; }
  // A body that was not a JSON-RPC message at all is a transport-level 400.
  if (response.error?.code === RPC_ERROR.INVALID_REQUEST && response.id === null) { res.status(400).json(response); return; }
  res.json(response);
});

const notAllowed = (_req: Request, res: Response): void => {
  res.setHeader("Allow", "POST, OPTIONS");
  res.status(405).json(rpcError(-32000, "Method not allowed. Use POST with a JSON-RPC 2.0 body."));
};
router.get("/mcp", notAllowed);
router.delete("/mcp", notAllowed);

export default router;
