export function createQuotaLimiter({ rules = {}, now = () => Date.now() } = {}) {
  const buckets = new Map();
  function check({ app, service, workspace, key = "default", cost = 1 } = {}) {
    const scope = workspace ? `workspace:${workspace}` : service ? `service:${service}` : `app:${app}`;
    const rule = rules[scope] ?? rules[app] ?? { limit: 100, windowMs: 60_000 };
    const bucketKey = `${scope}:${key}`;
    const current = buckets.get(bucketKey);
    const timestamp = now();
    const bucket = !current || timestamp - current.startedAt >= rule.windowMs ? { startedAt: timestamp, used: 0 } : current;
    bucket.used += cost;
    buckets.set(bucketKey, bucket);
    return Object.freeze({ allowed: bucket.used <= rule.limit, scope, limit: rule.limit, remaining: Math.max(0, rule.limit - bucket.used), resetAt: bucket.startedAt + rule.windowMs });
  }
  return Object.freeze({ check, reset: () => buckets.clear() });
}

/**
 * Shared token-window limiter for multi-replica services. The store owns the
 * atomic increment; callers only provide a stable scope/key and rule. Keeping
 * the storage contract small lets Redis, Postgres, or a platform-native
 * counter implement the same production behavior.
 */
export function createDistributedQuotaLimiter({ store, rules = {} } = {}) {
  if (!store || typeof store.consume !== "function") throw new Error("A shared quota store is required");
  return Object.freeze({
    async check({ app, service, workspace, key = "default", cost = 1 } = {}) {
      const scope = workspace ? `workspace:${workspace}` : service ? `service:${service}` : `app:${app}`;
      const rule = rules[scope] ?? rules[app] ?? { limit: 100, windowMs: 60_000 };
      const result = await store.consume({ key: `${scope}:${key}`, limit: rule.limit, windowMs: rule.windowMs, cost });
      return Object.freeze({ ...result, scope, limit: rule.limit });
    },
  });
}

/**
 * Postgres implementation using one atomic UPSERT. No read-then-write race is
 * possible, so two service replicas share the same window and limit.
 */
export async function createPostgresQuotaStore({ query, table = "rate_limit_buckets" } = {}) {
  if (typeof query !== "function") throw new Error("A Postgres query function is required");
  await query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      bucket_key TEXT PRIMARY KEY,
      window_started_at TIMESTAMPTZ NOT NULL,
      used BIGINT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  return Object.freeze({
    async consume({ key, limit, windowMs, cost = 1 } = {}) {
      if (!key || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1 || !Number.isSafeInteger(cost) || cost < 1) {
        throw new Error("Invalid shared rate-limit parameters");
      }
      const { rows } = await query(`
        INSERT INTO ${table} (bucket_key, window_started_at, used)
        VALUES ($1, now(), $2)
        ON CONFLICT (bucket_key) DO UPDATE
        SET window_started_at = CASE
              WHEN ${table}.window_started_at <= now() - ($3 || ' milliseconds')::interval THEN now()
              ELSE ${table}.window_started_at
            END,
            used = CASE
              WHEN ${table}.window_started_at <= now() - ($3 || ' milliseconds')::interval THEN $2
              ELSE ${table}.used + $2
            END,
            updated_at = now()
        RETURNING used, window_started_at, EXTRACT(EPOCH FROM (window_started_at + ($3 || ' milliseconds')::interval)) * 1000 AS reset_at
      `, [key, cost, String(windowMs)]);
      const row = rows[0];
      const used = Number(row.used);
      return { allowed: used <= limit, used, remaining: Math.max(0, limit - used), resetAt: Number(row.reset_at) };
    },
  });
}