import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { encryptField, decryptField } from "../vault/crypto/field-encryption";
import { requireVaultEntryOwnership } from "../vault/security/entity-ownership";
import { requireLocalAccountOwnership } from "../vault/security/local-account-ownership";
import { listLocalAccountValueHistory, saveLocalAccountValue } from "../vault/application/local-account/value";

const router = Router();
const safe = (v: unknown) => v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;
const num = (v: unknown) => Number.isFinite(Number(v)) ? Number(v) : 0;

// C21 — the `vault_entries` (not `local_accounts`) routes in this file keep their own deny
// bodies via `onDeny`. `local-accounts.ts`'s `localAccountResource` (C15) is a separate
// table/owner shape, reused for the two `/local-accounts/:id/...` routes below (C22).
// VLT-GAP-01-C: ownership gate now comes from the Vault security module (was a local duplicate wrapper).

router.get("/value-history/pnl", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const period = [7, 14, 28].includes(Number(req.query.period)) ? Number(req.query.period) : 7;
  const metric = req.query.metric === "follower" ? "follower" : "value";
  // Optional per-entity / per-platform filters
  const sourceTypeFilter = req.query.sourceType ? `AND source_type = ${safe(String(req.query.sourceType))}` : "";
  const sourceIdFilter = req.query.sourceId && !isNaN(Number(req.query.sourceId)) ? `AND source_id = ${Number(req.query.sourceId)}` : "";
  const targetFilter = req.query.target ? `AND target = ${safe(String(req.query.target))}` : "";
  try {
    // When viewing aggregate PNL (no sourceId), exclude rows that belong to
    // banned vault or local entities — banned entities should not contribute
    // to the global P&L view.
    const bannedExcludeClause = (!sourceIdFilter)
      ? `AND NOT EXISTS (
           SELECT 1 FROM vault_entries ve
           WHERE ve.user_id = ${userId} AND ve.id = source_id AND source_type = 'vault' AND ve.status = 'banned'
         )`
      : "";
    const rows = await db.execute(sql.raw(`
      SELECT source_type, source_id, target, label, value, buy_value, note, created_at
      FROM value_history WHERE user_id = ${userId} AND metric = ${safe(metric)}
      ${sourceTypeFilter} ${sourceIdFilter} ${targetFilter}
      ${bannedExcludeClause}
      AND created_at >= NOW() - INTERVAL '${period} days'
      ORDER BY created_at DESC
    `));
    const history = rows.rows as any[];
    const grouped = new Map<string, any>();
    for (const row of history) {
      const key = `${row.source_type}:${row.source_id}:${row.target}`;
      const current = grouped.get(key);
      if (!current) {
        grouped.set(key, {
          sourceType: row.source_type, sourceId: row.source_id, target: row.target, label: row.label,
          startValue: Number(row.value), endValue: Number(row.value),
          startBuyValue: Number(row.buy_value), endBuyValue: Number(row.buy_value), entries: 1,
        });
        continue;
      }
      // Results are newest-first: keep the newest snapshot as end and
      // continuously move the oldest snapshot into the start position.
      current.startValue = Number(row.value);
      current.startBuyValue = Number(row.buy_value);
      current.entries += 1;
    }
    const items = [...grouped.values()].map(item => ({
      ...item,
      // If only 1 data point in the period, show absolute profit (worth − cost).
      // Otherwise show the change in profit over the period.
      pnl: item.entries === 1
        ? item.endValue - item.endBuyValue
        : item.endValue - item.endBuyValue - (item.startValue - item.startBuyValue),
    }));
    res.json({ period, metric, history, items, totalPnl: items.reduce((sum, item) => sum + item.pnl, 0) });
  } catch (err: any) { res.status(500).json({ error: "Unable to load value history", detail: err?.message }); }
});

router.get("/vault/:id/value-history", requireAuth, requireVaultEntryOwnership("vault_entry.value_history.read", (_req, res) => { res.json([]); }), async (req, res): Promise<void> => {
  const userId = req.user!.userId; const id = Number(req.params.id);
  const metric = req.query.metric === "follower" ? "follower" : req.query.metric === "all" ? null : "value";
  const metricClause = metric ? `AND metric = ${safe(metric)}` : "";
  const rows = await db.execute(sql.raw(`SELECT * FROM value_history WHERE user_id = ${userId} AND source_type = 'vault' AND source_id = ${id} ${metricClause} ORDER BY created_at DESC`));
  res.json(rows.rows);
});

router.post("/vault/:id/value", requireAuth, requireVaultEntryOwnership("vault_entry.value.update", (_req, res) => { res.status(404).json({ error: "Entity not found" }); }), async (req, res): Promise<void> => {
  const userId = req.user!.userId; const id = Number(req.params.id);
  const target = String(req.body.target || "entity");
  const mode = req.body.mode === "add" ? "add" : "set"; // "add" increments on top of the current value; "set" overwrites it
  const amount = num(req.body.value); const buyAmount = num(req.body.buyValue); const note = req.body.note || null;
  if (!Number.isInteger(id) || !Number.isFinite(amount)) { res.status(400).json({ error: "Valid value required" }); return; }
  try {
    const found = await db.execute(sql.raw(`SELECT * FROM vault_entries WHERE id = ${id} AND user_id = ${userId}`));
    const entry: any = found.rows[0]; if (!entry) { res.status(404).json({ error: "Entity not found" }); return; }

    let value = amount, buyValue = buyAmount;
    if (target === "entity" || target === "account") {
      if (mode === "add") { value = num(entry.current_value) + amount; buyValue = num(entry.current_buy_value) + buyAmount; }
      await db.execute(sql.raw(`UPDATE vault_entries SET current_value = ${value}, current_buy_value = ${buyValue}, updated_at = NOW() WHERE id = ${id} AND user_id = ${userId}`));
    } else if (/^(twitter|discord|telegram)$/.test(target)) {
      const col = target;
      if (mode === "add") { value = num(entry[`${col}_worth`]) + amount; buyValue = num(entry[`${col}_buy_value`]) + buyAmount; }
      await db.execute(sql.raw(`UPDATE vault_entries SET ${col}_worth = ${safe(String(value))}, ${col}_buy_value = ${safe(String(buyValue))}, updated_at = NOW() WHERE id = ${id} AND user_id = ${userId}`));
    } else if (target.startsWith("other:")) {
      const label = target.slice(6).replace(/'/g, "''"); const list = JSON.parse(decryptField(entry.other_accounts) || "[]");
      if (mode === "add") {
        const current = list.find((item: any) => String(item.platform || "") === target.slice(6));
        value = num(current?.worth) + amount; buyValue = num(current?.buyValue) + buyAmount;
      }
      const updated = list.map((item: any) => String(item.platform || "") === target.slice(6) ? { ...item, worth: String(value), buyValue: String(buyValue) } : item);
      await db.execute(sql.raw(`UPDATE vault_entries SET other_accounts = ${safe(encryptField(JSON.stringify(updated)))}, updated_at = NOW() WHERE id = ${id} AND user_id = ${userId}`));
      void label;
    }
    const result = await db.execute(sql.raw(`INSERT INTO value_history (user_id, source_type, source_id, target, label, metric, value, buy_value, note) VALUES (${userId}, 'vault', ${id}, ${safe(target)}, ${safe(req.body.label || target)}, 'value', ${value}, ${buyValue}, ${safe(note)}) RETURNING *`));
    res.status(201).json(result.rows[0]);
  } catch (err: any) { res.status(500).json({ error: "Unable to save value", detail: err?.message }); }
});

// ─── Follower tracking (Info sub-tab) — same add/set + history/note pattern
// as value tracking above, stored on value_history with metric='follower'.
router.post("/vault/:id/followers", requireAuth, requireVaultEntryOwnership("vault_entry.followers.update", (_req, res) => { res.status(404).json({ error: "Entity not found" }); }), async (req, res): Promise<void> => {
  const userId = req.user!.userId; const id = Number(req.params.id);
  const target = String(req.body.target || "entity");
  const mode = req.body.mode === "add" ? "add" : "set";
  const amount = num(req.body.value); const note = req.body.note || null;
  if (!Number.isInteger(id) || !Number.isFinite(amount)) { res.status(400).json({ error: "Valid follower count required" }); return; }
  try {
    const found = await db.execute(sql.raw(`SELECT * FROM vault_entries WHERE id = ${id} AND user_id = ${userId}`));
    const entry: any = found.rows[0]; if (!entry) { res.status(404).json({ error: "Entity not found" }); return; }

    let followers: number;
    if (target === "entity" || target === "account") {
      followers = Math.max(0, Math.round(mode === "add" ? num(entry.followers) + amount : amount));
      await db.execute(sql.raw(`UPDATE vault_entries SET followers = ${followers}, updated_at = NOW() WHERE id = ${id} AND user_id = ${userId}`));
    } else if (/^(twitter|discord|telegram)$/.test(target)) {
      const col = `${target}_followers`;
      followers = Math.max(0, Math.round(mode === "add" ? num(entry[col]) + amount : amount));
      await db.execute(sql.raw(`UPDATE vault_entries SET ${col} = ${safe(String(followers))}, updated_at = NOW() WHERE id = ${id} AND user_id = ${userId}`));
    } else {
      res.status(400).json({ error: "Unsupported follower target" }); return;
    }
    const result = await db.execute(sql.raw(`INSERT INTO value_history (user_id, source_type, source_id, target, label, metric, value, buy_value, note) VALUES (${userId}, 'vault', ${id}, ${safe(target)}, ${safe(req.body.label || target)}, 'follower', ${followers}, 0, ${safe(note)}) RETURNING *`));
    res.status(201).json({ followers, history: result.rows[0] });
  } catch (err: any) { res.status(500).json({ error: "Unable to save follower count", detail: err?.message }); }
});

// VLT-GAP-02-C — the two `local_accounts` routes below are thin adapters over the Vault
// application owner (vault/application/local-account/value); the ownership gate comes from
// the Vault security module. Paths, order and middleware chains are unchanged.
router.get("/local-accounts/:id/value-history", requireAuth, requireLocalAccountOwnership("local_account.value_history.read", (_req, res) => { res.json([]); }), async (req, res): Promise<void> => {
  const out = await listLocalAccountValueHistory(req.user!.userId, req.params.id);
  res.status(out.status).json(out.body);
});

router.post("/local-accounts/:id/value", requireAuth, requireLocalAccountOwnership("local_account.value.update", (_req, res) => { res.status(404).json({ error: "Account not found" }); }), async (req, res): Promise<void> => {
  const out = await saveLocalAccountValue(req.user!.userId, req.params.id, req.body);
  res.status(out.status).json(out.body);
});

export default router;
