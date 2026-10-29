/**
 * Phase H6.2 — every extracted service (finance, vault, mail, notification,
 * marketplace, search, ai, workflow, ...) held its domain state in a plain
 * `new Map()`. That's fine until the process restarts or gets replaced
 * (deploy, crash, autoscale-down): the map is gone and so is every account,
 * transaction, vault record, listing, etc. it held.
 *
 * `createStateStore` gives each service a drop-in replacement for
 * `new Map()` that is durable across restarts without changing any call
 * site: every route handler that did `accounts.set(id, row)` or
 * `accounts.get(id)` keeps doing exactly that. The durability is added by
 * wrapping a real `Map` so `.set()`/`.delete()` also persist to Postgres,
 * and by hydrating the map from Postgres before the store is handed back,
 * so a fresh process picks up right where the last one left off.
 *
 * This is intentionally NOT a shared-state solution for multiple replicas
 * running concurrently — reads are served from the in-process cache, so two
 * replicas of the same service can drift until each writes/restarts. That
 * class of problem (shared idempotency, load-balanced replicas reading each
 * other's writes) is Phase H6.3's `@ayzen/idempotency` hardening and any
 * follow-on read-through work; H6.2's scope is "does this service's state
 * survive its own restart", which this closes.
 */

import { selectDatabaseUrl } from "@ayzen/config";

const TABLE = "service_state";

function toRows(map) {
  return [...map.entries()];
}

/**
 * The in-memory fallback. Used when a service has no DATABASE_URL and has
 * explicitly opted into ephemeral state (ALLOW_SERVICE_MEMORY_STORE=true),
 * e.g. for local development or a service the roadmap has documented as
 * deliberately stateless/ephemeral. Plain `Map`, no wrapping.
 */
export function createInMemoryStateStore() {
  return new Map();
}

/**
 * Wrap a real `Map` so mutating it also queues a durable write. Every method
 * other than `set`/`delete` is untouched native `Map` behavior (`.get`,
 * `.has`, `.size`, `.values()`, iteration, etc.), so this is safe to hand to
 * code that only knows the `Map` interface.
 */
function makeDurable(map, { query, service, collection }) {
  const queue = [];
  let flushPromise = null;

  async function runFlush() {
    while (queue.length) {
      const op = queue[0];
      try {
        if (op.type === "set") {
          await query(
            `INSERT INTO ${TABLE} (service, collection, id, data, updated_at)
             VALUES ($1, $2, $3, $4::jsonb, now())
             ON CONFLICT (service, collection, id)
             DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
            [service, collection, op.id, JSON.stringify(op.value)],
          );
        } else {
          await query(
            `DELETE FROM ${TABLE} WHERE service = $1 AND collection = $2 AND id = $3`,
            [service, collection, op.id],
          );
        }
        queue.shift();
      } catch (error) {
        // Leave the op at the front of the queue and back off; the next
        // flush() call (triggered by the next write, or the caller's own
        // retry) will retry it. We deliberately don't drop failed writes:
        // an in-memory `.set()` that never reaches Postgres is exactly
        // the bug this store exists to close.
        console.error(JSON.stringify({
          level: "error",
          event: "service_state.persist_failed",
          service,
          collection,
          op: op.type,
          id: op.id,
          error: String(error?.message ?? error),
        }));
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  function flush() {
    if (!flushPromise) {
      flushPromise = runFlush().finally(() => { flushPromise = null; });
    }
    return flushPromise;
  }

  const nativeSet = Map.prototype.set.bind(map);
  const nativeDelete = Map.prototype.delete.bind(map);
  const nativeClear = Map.prototype.clear.bind(map);

  map.set = (id, value) => {
    nativeSet(id, value);
    queue.push({ type: "set", id, value });
    void flush();
    return map;
  };
  map.delete = (id) => {
    const existed = map.has(id);
    nativeDelete(id);
    if (existed) {
      queue.push({ type: "delete", id });
      void flush();
    }
    return existed;
  };
  map.clear = () => {
    for (const id of [...map.keys()]) map.delete(id);
    nativeClear();
  };
  // Exposed for tests and for an operator/health-check to confirm every
  // queued write has actually landed before treating a shutdown as clean.
  map.flush = flush;
  map.pendingWrites = () => queue.length;

  return map;
}

/**
 * Ensure the shared `service_state` table exists. Idempotent — safe to call
 * on every boot of every service; see migrations/118 for the tracked copy
 * of this DDL (this inline version exists so a service works the first
 * time against a fresh database even before migrations have been run, the
 * same "ensure, don't assume" approach `createPostgresWorkflowStore`-style
 * stores elsewhere in the repo don't take, but that services booting
 * standalone in dev benefit from).
 */
async function ensureTable(query) {
  await query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      service TEXT NOT NULL,
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (service, collection, id)
    )
  `);
}

/**
 * Build a durable, Postgres-backed store for one service's one collection
 * (e.g. service: "finance", collection: "accounts"). Hydrates from Postgres
 * synchronously (as part of the returned Promise) before resolving, so the
 * caller can `await` it at module scope and be sure the map is fully
 * populated before the HTTP server starts accepting requests.
 */
export async function createPostgresStateStore({ query, service, collection }) {
  if (typeof query !== "function") throw new Error("A Postgres query function is required");
  if (!service) throw new Error("service is required");
  if (!collection) throw new Error("collection is required");

  await ensureTable(query);
  const { rows } = await query(
    `SELECT id, data FROM ${TABLE} WHERE service = $1 AND collection = $2 ORDER BY updated_at`,
    [service, collection],
  );
  const map = new Map(rows.map((row) => [row.id, row.data]));
  return makeDurable(map, { query, service, collection });
}

/**
 * Convenience wrapper matching the DATABASE_URL / ALLOW_*_MEMORY_STORE
 * pattern already used by apps/worker for workflow state: pass a `query`
 * function when one is available (built from the service's own pg.Pool),
 * and this returns a durable store; omit it and this only succeeds if
 * `allowMemoryFallback` is true, otherwise it throws so a service can't
 * silently boot with state that won't survive a restart.
 */
export async function createStateStore({ service, collection, query, allowMemoryFallback = false }) {
  if (query) return createPostgresStateStore({ query, service, collection });
  if (allowMemoryFallback) return createInMemoryStateStore();
  throw new Error(
    `${service} requires DATABASE_URL for durable "${collection}" state; set ALLOW_SERVICE_MEMORY_STORE=true only for local development`,
  );
}

const pools = new Map(); // databaseUrl -> pg.Pool, shared across every createStateStore() call in a process

/**
 * Build (and cache, per connection string) a `query` function backed by a
 * real pg.Pool, or return undefined if no DATABASE_URL is configured. Kept
 * here — rather than duplicated in every service's index.mjs — so `pg` is
 * a dependency of this one package instead of nine, and so multiple
 * collections in the same service (e.g. finance's "accounts" and
 * "transactions") share one pool instead of opening one per collection.
 */
export async function createPostgresQuery({ databaseUrl = selectDatabaseUrl(), poolMax = Number(process.env.SERVICE_DB_POOL_MAX ?? 5) } = {}) {
  if (!databaseUrl) return undefined;
  let pool = pools.get(databaseUrl);
  if (!pool) {
    // Lazy/dynamic import: services that run with ALLOW_SERVICE_MEMORY_STORE
    // (no DATABASE_URL, e.g. local dev) never need the `pg` driver loaded at
    // all, and it keeps this module importable in environments that haven't
    // installed `pg` but also never call this function.
    const { default: pg } = await import("pg");
    pool = new pg.Pool({ connectionString: databaseUrl, max: poolMax });
    pools.set(databaseUrl, pool);
  }
  return (text, params) => pool.query(text, params);
}

export const __internal = { toRows };