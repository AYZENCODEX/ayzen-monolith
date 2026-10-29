export function createResiliencePolicy({ timeoutMs = 10_000, retryAttempts = 2, failureThreshold = 3, resetMs = 30_000, bulkheadLimit = 20 } = {}) {
  if (![timeoutMs, retryAttempts, failureThreshold, resetMs, bulkheadLimit].every((value) => Number.isFinite(value) && value > 0)) throw new Error("Invalid resilience policy");
  return Object.freeze({ timeoutMs, retryAttempts, failureThreshold, resetMs, bulkheadLimit, backoffMs: 100, jitter: true, fallback: "explicit-only" });
}