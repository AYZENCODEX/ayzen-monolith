import { createQuotaLimiter } from "@ayzen/rate-limit";

export function createQuotaService(options = {}) {
  const limiter = createQuotaLimiter(options);
  return Object.freeze({ check: limiter.check, reset: limiter.reset });
}