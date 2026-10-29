export function withTimeout(operation, timeoutMs, code = "UPSTREAM_TIMEOUT") {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Timeout must be positive");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return Promise.race([
    Promise.resolve().then(() => operation(controller.signal)),
    new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject(Object.assign(new Error("Operation timed out"), { code })), { once: true })),
  ]).finally(() => clearTimeout(timer));
}

export function createCircuitBreaker({ failureThreshold = 5, resetTimeoutMs = 30_000 } = {}) {
  let failures = 0;
  let openedAt = 0;
  return {
    get state() {
      return openedAt ? "open" : "closed";
    },
    async run(operation) {
      if (openedAt && Date.now() - openedAt < resetTimeoutMs) throw Object.assign(new Error("Circuit is open"), { code: "CIRCUIT_OPEN" });
      if (openedAt) openedAt = 0;
      try {
        const result = await operation();
        failures = 0;
        return result;
      } catch (error) {
        failures += 1;
        if (failures >= failureThreshold) openedAt = Date.now();
        throw error;
      }
    },
  };
}

export async function withRetry(operation, {
  attempts = 3,
  baseDelayMs = 100,
  maxDelayMs = 5_000,
  shouldRetry = () => true,
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
} = {}) {
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error("Retry attempts must be positive");
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !shouldRetry(error, attempt)) throw error;
      const delay = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1))) + Math.floor(Math.random() * Math.max(1, baseDelayMs));
      await sleep(delay);
    }
  }
  throw lastError;
}

export function createBulkhead({ limit = 10 } = {}) {
  let active = 0;
  const queue = [];
  function drain() {
    while (active < limit && queue.length) {
      active += 1;
      const item = queue.shift();
      Promise.resolve().then(item.operation).then(item.resolve, item.reject).finally(() => {
        active -= 1;
        drain();
      });
    }
  }
  return {
    run(operation) {
      return new Promise((resolve, reject) => {
        queue.push({ operation, resolve, reject });
        drain();
      });
    },
    get active() { return active; },
    get queued() { return queue.length; },
  };
}

export function createResilientOperation({
  breaker = createCircuitBreaker(),
  bulkhead = createBulkhead(),
  attempts = 2,
} = {}) {
  return {
    run(operation) {
      return bulkhead.run(() => breaker.run(() => withRetry(operation, { attempts })));
    },
    status() {
      return { circuit: breaker.state, active: bulkhead.active, queued: bulkhead.queued };
    },
  };
}