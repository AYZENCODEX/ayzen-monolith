import crypto from "node:crypto";

export function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value, Object.keys(value ?? {}).sort())).digest("hex");
}

export function createIdempotencyStore({ now = () => Date.now(), ttlMs = 86_400_000 } = {}) {
  const entries = new Map();
  function prune() {
    for (const [key, entry] of entries) if (entry.expiresAt <= now()) entries.delete(key);
  }
  return Object.freeze({
    begin({ scope, key, request } = {}) {
      prune();
      if (typeof scope !== "string" || !scope || typeof key !== "string" || !key) throw new Error("Idempotency scope and key are required");
      const id = `${scope}:${key}`;
      const hash = fingerprint(request);
      const prior = entries.get(id);
      if (prior && prior.fingerprint !== hash) throw new Error("Idempotency key was reused with a different request");
      if (prior) return { status: "replay", value: prior.value };
      const entry = { fingerprint: hash, value: undefined, expiresAt: now() + ttlMs };
      entries.set(id, entry);
      return { status: "reserved", complete(value) { entry.value = value; return value; } };
    },
    get(scope, key) {
      prune();
      return entries.get(`${scope}:${key}`)?.value;
    },
    size() { prune(); return entries.size; },
  });
}

/**
 * Phase H6.3 — every service that de-dupes on an `idempotency-key` header
 * (finance, mail, notification, marketplace, ai, workflow, vault) did it
 * through `@ayzen/service-runtime`'s `createIdempotencyStore`: a plain
 * per-process `Map`. That dedups fine as long as the same replica handles
 * the retry, but a load balancer has no reason to route a retried request
 * back to the replica that saw the original — so two replicas of the same
 * service can each accept the "same" request and produce the effect twice,
 * exactly the class of bug idempotency keys exist to prevent. The in-memory
 * store also forgets every reservation on restart/redeploy.
 *
 * `createPostgresIdempotencyStore` gives call sites the same `get(key)` /
 * `set(key, response)` shape those services already call (unlike
 * `createIdempotencyStore` above, which is scope+key/begin-complete shaped
 * and used elsewhere), but backed by one shared table so every replica of
 * every service sees the same reservations. `get`/`set` are now async
 * (a real network round trip), so callers must `await` them — that's the
 * one call-site change this fix requires beyond the constructor swap.
 */
const RECORDS_TABLE = "idempotency_records";

async function ensureRecordsTable(query) {
  await query(`
    CREATE TABLE IF NOT EXISTS ${RECORDS_TABLE} (
      key TEXT PRIMARY KEY,
      response JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idempotency_records_expires_at_idx ON ${RECORDS_TABLE} (expires_at)`);
}

export async function createPostgresIdempotencyStore({ query, ttlMs = 86_400_000, pruneIntervalMs = 60_000 }) {
  if (typeof query !== "function") throw new Error("A Postgres query function is required");
  await ensureRecordsTable(query);
  let lastPruneAt = 0;
  async function pruneExpired() {
    const nowMs = Date.now();
    // Every set() opportunistically sweeps expired rows so a table nobody
    // ever reads back from doesn't grow forever, but a real DELETE on every
    // single write would be wasteful — throttle it to once per interval.
    if (nowMs - lastPruneAt < pruneIntervalMs) return;
    lastPruneAt = nowMs;
    await query(`DELETE FROM ${RECORDS_TABLE} WHERE expires_at <= now()`);
  }
  return Object.freeze({
    async get(key) {
      if (!key) return undefined;
      const { rows } = await query(
        `SELECT response FROM ${RECORDS_TABLE} WHERE key = $1 AND expires_at > now()`,
        [key],
      );
      return rows[0]?.response;
    },
    async set(key, response) {
      if (!key) return;
      await query(
        `INSERT INTO ${RECORDS_TABLE} (key, response, created_at, expires_at)
         VALUES ($1, $2::jsonb, now(), now() + ($3 || ' milliseconds')::interval)
         ON CONFLICT (key) DO UPDATE SET response = EXCLUDED.response, expires_at = EXCLUDED.expires_at`,
        [key, JSON.stringify(response), String(ttlMs)],
      );
      await pruneExpired();
    },
    async size() {
      const { rows } = await query(`SELECT count(*)::int AS count FROM ${RECORDS_TABLE} WHERE expires_at > now()`);
      return rows[0]?.count ?? 0;
    },
  });
}

/**
 * The in-memory fallback, kept for the same `ALLOW_SERVICE_MEMORY_STORE=true`
 * local-dev escape hatch `@ayzen/service-state`'s `createStateStore` uses
 * (this is the same `Map`-backed logic `@ayzen/service-runtime` used to own
 * outright; it now only runs when a service has explicitly opted out of
 * durability, never as a silent default).
 */
export function createInMemoryIdempotencyStore({ ttlMs = 86_400_000, maxEntries = 10_000 } = {}) {
  const entries = new Map();
  function prune() {
    const cutoff = Date.now() - ttlMs;
    for (const [key, value] of entries) if (value.createdAt < cutoff) entries.delete(key);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  }
  return {
    get(key) {
      prune();
      return key ? entries.get(key)?.response : undefined;
    },
    set(key, response) {
      if (!key) return;
      prune();
      entries.set(key, { createdAt: Date.now(), response });
    },
    size() {
      prune();
      return entries.size;
    },
  };
}

/**
 * Convenience wrapper mirroring `createStateStore`'s DATABASE_URL /
 * `ALLOW_SERVICE_MEMORY_STORE` contract exactly: pass the service's
 * already-pooled Postgres `query` function (from
 * `@ayzen/service-state`'s `createPostgresQuery()`, shared with that
 * service's state stores) and every replica dedups against the same table;
 * omit it and this only succeeds when `allowMemoryFallback` is true,
 * otherwise it throws rather than let a service silently boot with
 * per-replica idempotency that can't actually prevent a double effect.
 */
export async function createSharedIdempotencyStore({ service, query, ttlMs, allowMemoryFallback = false }) {
  if (query) return createPostgresIdempotencyStore({ query, ttlMs });
  if (allowMemoryFallback) return createInMemoryIdempotencyStore({ ttlMs });
  throw new Error(
    `${service ?? "service"} requires DATABASE_URL for idempotency keys to be honored across replicas; set ALLOW_SERVICE_MEMORY_STORE=true only for local development`,
  );
}