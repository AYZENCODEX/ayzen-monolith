import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { after, test } from "node:test";
import { eq, sql } from "drizzle-orm";
import { db, pool, financeLedgerEntriesTable, financeAssetsTable } from "@workspace/db";

// F11: Finance money columns are double precision (were real/float32). Isolated Finance test schema only
// (pnpm test:finance-db). NOT YET EXECUTED. The isolated schema is built by the same migration statements
// production runs, including the guarded real -> double precision conversion.

if (process.env.DATABASE_URL_TARGET !== "replit-test") {
  throw new Error('Finance database tests require DATABASE_URL_TARGET="replit-test".');
}

const userId = -randomInt(1, 2_000_000_000);

after(async () => {
  try {
    await db.delete(financeLedgerEntriesTable).where(eq(financeLedgerEntriesTable.userId, userId));
    await db.delete(financeAssetsTable).where(eq(financeAssetsTable.userId, userId));
  } finally {
    await pool.end();
  }
});

test("F11: every Finance money column in the test schema is double precision, none is real", async () => {
  const result = await db.execute(sql`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name LIKE 'finance\\_%' AND data_type IN ('real', 'double precision')
  `);
  const rows = result.rows as Array<{ table_name: string; column_name: string; data_type: string }>;
  const stillReal = rows.filter((r) => r.data_type === "real").map((r) => `${r.table_name}.${r.column_name}`);
  assert.deepEqual(stillReal, [], "no finance_* column may remain float32");
  const doubles = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
  for (const col of ["finance_ledger_entries.amount", "finance_journal_lines.debit", "finance_journal_lines.credit", "finance_assets.total_value", "finance_amortization.remaining_balance"]) {
    assert.ok(doubles.has(col), `${col} should be double precision`);
  }
});

test("F11: amounts that float32 corrupted now round-trip exactly", async () => {
  // float32 stored these as 1,000,000.00 / 99,999.992 / 16,777,216 respectively.
  const cases = [1_000_000.01, 99_999.99, 16_777_217, 123_456_789.12, 0.01, 2_500_000_000.5];
  for (const amount of cases) {
    const [row] = await db.insert(financeLedgerEntriesTable).values({
      userId, kind: "expense", title: `precision ${amount}`, amount, currency: "BDT", category: "Test", occurredDate: new Date("2026-01-15T00:00:00.000Z"), status: "paid",
    }).returning();
    assert.equal(row.amount, amount, `insert returned ${row.amount}`);
    const [back] = await db.select().from(financeLedgerEntriesTable).where(eq(financeLedgerEntriesTable.id, row.id));
    assert.equal(back.amount, amount, `stored ${back.amount}`);
  }
});

test("F11: SUM over money columns stays a JS number and keeps cents", async () => {
  const total = 10_000_000.07;
  await db.insert(financeLedgerEntriesTable).values([
    { userId, kind: "expense", title: "sum a", amount: 5_000_000.03, currency: "BDT", category: "Sum", occurredDate: new Date("2026-02-01T00:00:00.000Z"), status: "paid" },
    { userId, kind: "expense", title: "sum b", amount: 5_000_000.04, currency: "BDT", category: "Sum", occurredDate: new Date("2026-02-02T00:00:00.000Z"), status: "paid" },
  ]);
  const [agg] = await db.select({ total: sql<number>`COALESCE(SUM(${financeLedgerEntriesTable.amount}), 0)` })
    .from(financeLedgerEntriesTable)
    .where(sql`${financeLedgerEntriesTable.userId} = ${userId} AND ${financeLedgerEntriesTable.category} = 'Sum'`);
  assert.equal(typeof agg.total, "number", "pg must still return float8 aggregates as numbers, not strings");
  assert.ok(Math.abs(agg.total - total) < 1e-6, `sum was ${agg.total}`);
});

test("F11: the conversion is a no-op the second time (idempotent) and cleans float32 noise on first run", async () => {
  // Scratch table shaped like the old schema, on ONE connection (TEMP tables are per-connection).
  const client = await pool.connect();
  try {
    await client.query("CREATE TEMP TABLE f11_scratch (amount REAL, rate REAL)");
    await client.query("INSERT INTO f11_scratch VALUES (99999.99::real, 12.5::real), (0.1::real, 0.1::real)");
    const convert = `
      DO $f11_scratch$
      DECLARE r record;
      BEGIN
        FOR r IN
          SELECT c.column_name AS col, v.digits AS digits
          FROM information_schema.columns c
          JOIN (VALUES ('amount',2),('rate',6)) AS v(col, digits) ON v.col = c.column_name
          WHERE c.table_name = 'f11_scratch' AND c.table_schema LIKE 'pg_temp%' AND c.data_type = 'real'
        LOOP
          EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE double precision USING ROUND(%I::double precision::numeric, %s)::double precision', 'f11_scratch', r.col, r.col, r.digits);
        END LOOP;
      END
      $f11_scratch$`;
    await client.query(convert);
    await client.query(convert); // second run: nothing is `real` any more, must not fail or change values
    const { rows } = await client.query("SELECT amount, rate FROM f11_scratch ORDER BY amount DESC");
    assert.equal(rows[0].amount, 99999.99, "float32 noise 99999.9921875 is cleaned to 99999.99");
    assert.equal(rows[0].rate, 12.5);
    assert.equal(rows[1].rate, 0.1, "0.1 as float32 (0.10000000149...) is cleaned to 0.1 at 6 digits");
  } finally {
    await client.query("DROP TABLE IF EXISTS pg_temp.f11_scratch").catch(() => {});
    client.release();
  }
});
