/**
 * mcp-server/rate-limit.ts
 *
 * Per-principal fixed-window limiter for the MCP endpoint (Phase 8). Keyed by
 * user id, not IP: MCP clients such as Claude's connector call from shared
 * provider egress addresses, so an IP key would let one noisy user throttle
 * everyone behind the same address.
 *
 * In-memory, so the budget is per server instance. That is fine for abuse
 * control (the global IP limiter still applies upstream); it is not a billing
 * meter.
 *
 *   MCP_RATE_LIMIT_PER_MIN   default 120 requests / minute / user
 */
export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window resets (use for Retry-After). */
  retryAfterSec: number;
}

export class FixedWindowLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  hit(key: string): RateLimitResult {
    const t = this.now();
    if (this.windows.size > 10_000) this.sweep(t);
    let w = this.windows.get(key);
    if (!w || w.resetAt <= t) {
      w = { count: 0, resetAt: t + this.windowMs };
      this.windows.set(key, w);
    }
    w.count += 1;
    const retryAfterSec = Math.max(1, Math.ceil((w.resetAt - t) / 1000));
    return { allowed: w.count <= this.limit, limit: this.limit, remaining: Math.max(0, this.limit - w.count), retryAfterSec };
  }

  private sweep(t: number): void {
    for (const [k, w] of this.windows) if (w.resetAt <= t) this.windows.delete(k);
  }
}

export function mcpRateLimitPerMinute(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.MCP_RATE_LIMIT_PER_MIN ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 120;
}
