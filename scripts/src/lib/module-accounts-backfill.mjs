/**
 * W1-P1: backfill logic for module_accounts (migrations/125_module_accounts.sql).
 *
 * "A user has a Sylo account" is derived from data the user owns in that module. SOURCES is the
 * single, reviewable attribution map (module -> owner columns). Every table/column below was
 * checked against lib/db/src/schema and artifacts/api-server/src/lib/schema-migrations.ts.
 *
 * Zynth has no per-user table in the monolith today (ai_agent_messages is the admin agent and has
 * no user_id), so nothing backfills it; Zynth accounts are provisioned lazily (source 'lazy') on
 * first use once W1-P2 lands.
 *
 * Pure: takes a `query(sql, params) -> Promise<{rows}>` function so the CLI (pg), the tests
 * (psql) and any future admin tool share it.
 */
export const SOURCES = Object.freeze({
  sylo: [
    { table: "vault_entries", column: "user_id" },
    { table: "local_accounts", column: "user_id" },
    { table: "kyc_entries", column: "user_id" },
    { table: "game_entries", column: "user_id" },
  ],
  ryft: [{ table: "wallets", column: "user_id" }],
  fyra: [{ table: "finance_ledger_entries", column: "user_id" }],
  verve: [
    { table: "marketplace_listings", column: "seller_id" },
    { table: "marketplace_orders", column: "buyer_id" },
    { table: "marketplace_orders", column: "seller_id" },
  ],
  skarn: [
    { table: "user_projects", column: "user_id" },
    { table: "project_enrollments", column: "user_id" },
    { table: "task_submissions", column: "user_id" },
  ],
  warde: [{ table: "team_members", column: "user_id" }],
  wisp: [
    { table: "email_accounts", column: "user_id" },
    { table: "ayzen_mail", column: "from_user_id" },
    { table: "users", column: "id", where: "s.ayzen_email IS NOT NULL" },
  ],
  zynth: [],
});

const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = (s) => {
  if (!IDENT.test(s)) throw new Error(`unsafe identifier: ${s}`);
  return s;
};

async function tableExists(query, table) {
  const { rows } = await query("SELECT to_regclass($1) AS t", [`public.${ident(table)}`]);
  return rows[0]?.t != null;
}

/** SELECT of distinct, existing user ids that own data in one source (orphans excluded). */
function sourceUsersSql({ table, column, where }) {
  const t = ident(table), c = ident(column);
  return `SELECT DISTINCT s.${c}::int AS user_id FROM ${t} s JOIN users u ON u.id = s.${c}` +
    (where ? ` WHERE ${where}` : "");
}

/**
 * Computes the attribution without writing. Returns
 * { modules: { [module]: { users: number[], perSource: [{table,column,users,orphans,skipped}] } } }.
 */
export async function discover(query, { modules = Object.keys(SOURCES) } = {}) {
  const out = { modules: {} };
  for (const module of modules) {
    if (!(module in SOURCES)) throw new Error(`unknown module: ${module}`);
    const all = new Set();
    const perSource = [];
    for (const src of SOURCES[module]) {
      if (!(await tableExists(query, src.table))) {
        perSource.push({ ...src, users: 0, orphans: 0, skipped: "table missing" });
        continue;
      }
      const { rows } = await query(sourceUsersSql(src));
      rows.forEach((r) => all.add(Number(r.user_id)));
      const orphan = await query(
        `SELECT count(*)::int AS n FROM ${ident(src.table)} s LEFT JOIN users u ON u.id = s.${ident(src.column)} ` +
          `WHERE s.${ident(src.column)} IS NOT NULL AND u.id IS NULL` + (src.where ? ` AND ${src.where}` : ""),
      );
      perSource.push({ ...src, users: rows.length, orphans: orphan.rows[0].n });
    }
    out.modules[module] = { users: [...all].sort((a, b) => a - b), perSource };
  }
  return out;
}

/** Splits discovery into what apply() would create vs. what already exists. */
export async function plan(query, opts) {
  const found = await discover(query, opts);
  const result = { modules: {} };
  for (const [module, info] of Object.entries(found.modules)) {
    const { rows } = await query("SELECT user_id FROM module_accounts WHERE module = $1", [module]);
    const have = new Set(rows.map((r) => Number(r.user_id)));
    result.modules[module] = {
      perSource: info.perSource,
      attributed: info.users.length,
      alreadyProvisioned: info.users.filter((u) => have.has(u)).length,
      toCreate: info.users.filter((u) => !have.has(u)),
    };
  }
  return result;
}

/**
 * Creates the missing module_accounts rows. Deterministic: user ids ascending, so the same
 * data always yields the same module_uids. Idempotent: re-running creates nothing new.
 * `query` must run inside a single session (the CLI wraps each module in BEGIN/COMMIT).
 */
export async function apply(query, opts) {
  const p = await plan(query, opts);
  const created = {};
  for (const [module, info] of Object.entries(p.modules)) {
    await query("BEGIN");
    try {
      for (const userId of info.toCreate) {
        await query("SELECT ayzen_provision_module_account($1::int, $2, 'backfill')", [userId, module]);
      }
      await query("COMMIT");
    } catch (e) {
      await query("ROLLBACK");
      throw e;
    }
    created[module] = info.toCreate.length;
  }
  return { plan: p, created };
}

export function formatReport(p) {
  const lines = ["module     attributed  existing  to-create"];
  for (const [m, i] of Object.entries(p.modules)) {
    lines.push(`${m.padEnd(10)} ${String(i.attributed).padStart(10)}  ${String(i.alreadyProvisioned).padStart(8)}  ${String(i.toCreate.length).padStart(9)}`);
    for (const s of i.perSource) {
      const note = s.skipped ? ` (${s.skipped})` : s.orphans ? ` (${s.orphans} orphan rows ignored)` : "";
      lines.push(`  - ${s.table}.${s.column}${s.where ? ` [${s.where}]` : ""}: ${s.users} users${note}`);
    }
  }
  return lines.join("\n");
}
