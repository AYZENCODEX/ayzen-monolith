import crypto from "node:crypto";
import { Router } from "express";
import {
  db, creditsTable, creditTransactionsTable, settingsTable,
  syloPaymentMethodsTable, syloCreditPricingTable, syloCreditOrdersTable,
} from "@workspace/db";
import { and, desc, eq, gte, like, sql } from "drizzle-orm";
import { broadcastEvent } from "./events";
import { requireAuth, requireAdmin, getRequestUser } from "../middlewares/auth";

/**
 * Sylo credit storefront — HTTP adapter. Sylo's own AZN purchase flow, saved
 * payment methods, order history and usage, kept apart from the AYZEN-wide
 * /credits routes (those keep serving the other modules untouched).
 *
 *   GET    /sylo/credit/summary                 balances, price list, where to send payment
 *   GET    /sylo/credit/payment-methods         saved bKash / Nagad / Binance / wallet
 *   POST   /sylo/credit/payment-methods
 *   PATCH  /sylo/credit/payment-methods/:id     label / default
 *   DELETE /sylo/credit/payment-methods/:id
 *   GET    /sylo/credit/orders                  my AZN purchases
 *   GET    /sylo/credit/orders/:id
 *   POST   /sylo/credit/orders                  buy AZN (pending until an admin verifies the payment)
 *   GET    /sylo/credit/usage                   metered Sylo spend (action keys "sylo.*")
 *   PUT    /admin/sylo/credit/pricing           change the AZN price
 *   GET    /admin/sylo/credit/orders            pending orders
 *   POST   /admin/sylo/credit/orders/:id/approve | /reject
 *
 * Every user-scoped query filters on the caller's id, so an id from another
 * account is indistinguishable from a missing one (404).
 */
const router = Router();

const KINDS = ["bkash", "nagad", "binance", "wallet"] as const;
type Kind = (typeof KINDS)[number];
const isKind = (v: unknown): v is Kind => typeof v === "string" && (KINDS as readonly string[]).includes(v);
const BD_MOBILE = /^01[3-9]\d{8}$/;
const NETWORKS = ["TRC20", "ERC20", "BEP20", "SOL", "BTC", "POLYGON"] as const;
const MAX_AZN = 1_000_000;

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));
const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;
const idParam = (v: string | string[] | undefined): number => {
  const n = parseInt(Array.isArray(v) ? v[0] : (v ?? ""), 10);
  return Number.isSafeInteger(n) && n > 0 ? n : NaN;
};

async function getPricing() {
  const [row] = await db.select().from(syloCreditPricingTable).where(eq(syloCreditPricingTable.id, 1));
  return {
    priceUsd: num(row?.priceUsd ?? 0.01),
    priceBdt: num(row?.priceBdt ?? 1.27),
    minAzn: row?.minAzn ?? 100,
  };
}

async function getPayTo() {
  const [s] = await db.select().from(settingsTable).limit(1);
  return {
    bkash: s?.bkashNumber || process.env["BKASH_NUMBER"] || null,
    nagad: s?.nagadNumber || process.env["NAGAD_NUMBER"] || null,
    binance: s?.usdtAddress || process.env["USDT_ADDRESS"] || null,
    network: s?.usdtNetwork || process.env["USDT_NETWORK"] || "TRC20",
  };
}

async function getOrCreateCredits(userId: number) {
  const [row] = await db.select().from(creditsTable).where(eq(creditsTable.userId, userId));
  if (row) return row;
  const [created] = await db.insert(creditsTable).values({ userId }).onConflictDoNothing().returning();
  if (created) return created;
  const [again] = await db.select().from(creditsTable).where(eq(creditsTable.userId, userId));
  return again;
}

function orderNo(): string {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `SYL-${d}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

/** Order row -> JSON with numbers instead of numeric strings. */
function orderJson(o: typeof syloCreditOrdersTable.$inferSelect) {
  return {
    id: o.id, orderNo: o.orderNo, aznAmount: num(o.aznAmount),
    unitPriceUsd: num(o.unitPriceUsd), unitPriceBdt: num(o.unitPriceBdt),
    totalUsd: num(o.totalUsd), totalBdt: num(o.totalBdt),
    payKind: o.payKind, payAccount: o.payAccount, referenceId: o.referenceId,
    status: o.status, adminNote: o.adminNote, approvedAt: o.approvedAt, createdAt: o.createdAt,
  };
}

// ─── Summary ─────────────────────────────────────────────────────────────────
router.get("/sylo/credit/summary", requireAuth, async (req, res): Promise<void> => {
  const user = getRequestUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const [credits, pricing, payTo] = await Promise.all([getOrCreateCredits(user.userId), getPricing(), getPayTo()]);
  const [pending] = await db.select({ n: sql<number>`count(*)::int` }).from(syloCreditOrdersTable)
    .where(and(eq(syloCreditOrdersTable.userId, user.userId), eq(syloCreditOrdersTable.status, "pending")));
  res.json({
    aznBalance: credits.aznBalance, creditBalance: credits.balance,
    pricing, payTo, pendingOrders: pending?.n ?? 0,
  });
});

// ─── Payment methods ─────────────────────────────────────────────────────────
router.get("/sylo/credit/payment-methods", requireAuth, async (req, res): Promise<void> => {
  const user = getRequestUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const rows = await db.select().from(syloPaymentMethodsTable)
    .where(eq(syloPaymentMethodsTable.userId, user.userId))
    .orderBy(desc(syloPaymentMethodsTable.isDefault), desc(syloPaymentMethodsTable.createdAt));
  res.json({ methods: rows });
});

router.post("/sylo/credit/payment-methods", requireAuth, async (req, res): Promise<void> => {
  const user = getRequestUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { kind, label, account, network, makeDefault } = (req.body ?? {}) as Record<string, unknown>;
  if (!isKind(kind)) { res.status(400).json({ error: "Choose bKash, Nagad, Binance or Wallet." }); return; }
  const acct = typeof account === "string" ? account.trim().replace(/\s+/g, "") : "";
  if (!acct) { res.status(400).json({ error: "Account is required." }); return; }
  if ((kind === "bkash" || kind === "nagad") && !BD_MOBILE.test(acct)) {
    res.status(400).json({ error: "Enter an 11-digit Bangladesh mobile number, e.g. 01712345678." }); return;
  }
  if (kind === "binance" && !/^\d{6,20}$/.test(acct)) {
    res.status(400).json({ error: "Enter your numeric Binance Pay ID." }); return;
  }
  let net: string | null = null;
  if (kind === "wallet") {
    if (acct.length < 20 || acct.length > 100 || !/^[A-Za-z0-9]+$/.test(acct)) {
      res.status(400).json({ error: "That doesn’t look like a wallet address." }); return;
    }
    net = typeof network === "string" && (NETWORKS as readonly string[]).includes(network.toUpperCase()) ? network.toUpperCase() : null;
    if (!net) { res.status(400).json({ error: `Pick a network: ${NETWORKS.join(", ")}.` }); return; }
  }
  const lab = typeof label === "string" && label.trim() ? label.trim().slice(0, 60) : null;

  const existing = await db.select({ n: sql<number>`count(*)::int` }).from(syloPaymentMethodsTable)
    .where(eq(syloPaymentMethodsTable.userId, user.userId));
  if ((existing[0]?.n ?? 0) >= 20) { res.status(409).json({ error: "You can save up to 20 payment methods." }); return; }

  const wantsDefault = makeDefault === true || (existing[0]?.n ?? 0) === 0;
  try {
    const created = await db.transaction(async (tx) => {
      if (wantsDefault) await tx.update(syloPaymentMethodsTable).set({ isDefault: false }).where(eq(syloPaymentMethodsTable.userId, user.userId));
      const [row] = await tx.insert(syloPaymentMethodsTable)
        .values({ userId: user.userId, kind, label: lab, account: acct, network: net, isDefault: wantsDefault })
        .returning();
      return row;
    });
    res.status(201).json({ method: created });
  } catch (err: any) {
    if (err?.code === "23505") { res.status(409).json({ error: "This payment method is already saved." }); return; }
    throw err;
  }
});

router.patch("/sylo/credit/payment-methods/:id", requireAuth, async (req, res): Promise<void> => {
  const user = getRequestUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = idParam(req.params.id);
  if (Number.isNaN(id)) { res.status(404).json({ error: "Not found" }); return; }
  const { label, makeDefault } = (req.body ?? {}) as Record<string, unknown>;
  const result = await db.transaction(async (tx) => {
    const [own] = await tx.select().from(syloPaymentMethodsTable)
      .where(and(eq(syloPaymentMethodsTable.id, id), eq(syloPaymentMethodsTable.userId, user.userId)));
    if (!own) return null;
    if (makeDefault === true) await tx.update(syloPaymentMethodsTable).set({ isDefault: false }).where(eq(syloPaymentMethodsTable.userId, user.userId));
    const [row] = await tx.update(syloPaymentMethodsTable).set({
      ...(typeof label === "string" ? { label: label.trim().slice(0, 60) || null } : {}),
      ...(makeDefault === true ? { isDefault: true } : {}),
      updatedAt: new Date(),
    }).where(and(eq(syloPaymentMethodsTable.id, id), eq(syloPaymentMethodsTable.userId, user.userId))).returning();
    return row;
  });
  if (!result) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ method: result });
});

router.delete("/sylo/credit/payment-methods/:id", requireAuth, async (req, res): Promise<void> => {
  const user = getRequestUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = idParam(req.params.id);
  if (Number.isNaN(id)) { res.status(404).json({ error: "Not found" }); return; }
  const removed = await db.delete(syloPaymentMethodsTable)
    .where(and(eq(syloPaymentMethodsTable.id, id), eq(syloPaymentMethodsTable.userId, user.userId))).returning({ id: syloPaymentMethodsTable.id });
  if (removed.length === 0) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ok: true });
});

// ─── Orders ──────────────────────────────────────────────────────────────────
router.get("/sylo/credit/orders", requireAuth, async (req, res): Promise<void> => {
  const user = getRequestUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const rows = await db.select().from(syloCreditOrdersTable)
    .where(eq(syloCreditOrdersTable.userId, user.userId))
    .orderBy(desc(syloCreditOrdersTable.createdAt)).limit(200);
  res.json({ orders: rows.map(orderJson) });
});

router.get("/sylo/credit/orders/:id", requireAuth, async (req, res): Promise<void> => {
  const user = getRequestUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = idParam(req.params.id);
  if (Number.isNaN(id)) { res.status(404).json({ error: "Not found" }); return; }
  const [row] = await db.select().from(syloCreditOrdersTable)
    .where(and(eq(syloCreditOrdersTable.id, id), eq(syloCreditOrdersTable.userId, user.userId)));
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ order: orderJson(row) });
});

router.post("/sylo/credit/orders", requireAuth, async (req, res): Promise<void> => {
  const user = getRequestUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { aznAmount, paymentMethodId, referenceId } = (req.body ?? {}) as Record<string, unknown>;

  const azn = round(num(aznAmount), 4);
  const pricing = await getPricing();
  if (!Number.isFinite(azn) || azn <= 0) { res.status(400).json({ error: "Enter how many AZN to buy." }); return; }
  if (azn < pricing.minAzn) { res.status(400).json({ error: `The minimum order is ${pricing.minAzn} AZN.` }); return; }
  if (azn > MAX_AZN) { res.status(400).json({ error: `The maximum order is ${MAX_AZN.toLocaleString("en-US")} AZN.` }); return; }

  const pmId = idParam(String(paymentMethodId ?? ""));
  if (Number.isNaN(pmId)) { res.status(400).json({ error: "Choose a saved payment method." }); return; }
  const [pm] = await db.select().from(syloPaymentMethodsTable)
    .where(and(eq(syloPaymentMethodsTable.id, pmId), eq(syloPaymentMethodsTable.userId, user.userId)));
  if (!pm) { res.status(400).json({ error: "Choose a saved payment method." }); return; }

  const ref = typeof referenceId === "string" ? referenceId.trim() : "";
  if (ref.length < 6 || ref.length > 128) { res.status(400).json({ error: "Enter the transaction ID or hash (6–128 characters)." }); return; }

  try {
    const [row] = await db.insert(syloCreditOrdersTable).values({
      orderNo: orderNo(), userId: user.userId, aznAmount: String(azn),
      unitPriceUsd: String(pricing.priceUsd), unitPriceBdt: String(pricing.priceBdt),
      totalUsd: String(round(azn * pricing.priceUsd, 4)), totalBdt: String(round(azn * pricing.priceBdt, 2)),
      payKind: pm.kind, payAccount: pm.account, paymentMethodId: pm.id, referenceId: ref,
    }).returning();
    broadcastEvent("sylo_credit_order_submitted", { userId: user.userId, orderId: row.id, azn });
    res.status(201).json({ order: orderJson(row), message: "Order received. AZN is added after we verify the payment, usually within 1–2 hours." });
  } catch (err: any) {
    if (err?.code === "23505") { res.status(409).json({ error: "This transaction ID has already been submitted." }); return; }
    throw err;
  }
});

// ─── Usage ───────────────────────────────────────────────────────────────────
router.get("/sylo/credit/usage", requireAuth, async (req, res): Promise<void> => {
  const user = getRequestUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const since = new Date(Date.now() - 30 * 86_400_000);
  const mine = and(eq(creditTransactionsTable.userId, user.userId), like(creditTransactionsTable.actionKey, "sylo.%"));
  const [rows, byAction, balance] = await Promise.all([
    db.select({
      id: creditTransactionsTable.id, type: creditTransactionsTable.type, credits: creditTransactionsTable.credits,
      actionKey: creditTransactionsTable.actionKey, notes: creditTransactionsTable.notes, createdAt: creditTransactionsTable.createdAt,
    }).from(creditTransactionsTable).where(mine).orderBy(desc(creditTransactionsTable.createdAt)).limit(100),
    db.select({
      actionKey: creditTransactionsTable.actionKey,
      spent: sql<number>`coalesce(sum(case when ${creditTransactionsTable.credits} < 0 then -${creditTransactionsTable.credits} else 0 end),0)::int`,
      uses: sql<number>`count(*) filter (where ${creditTransactionsTable.credits} < 0)::int`,
    }).from(creditTransactionsTable).where(and(mine, gte(creditTransactionsTable.createdAt, since))).groupBy(creditTransactionsTable.actionKey),
    getOrCreateCredits(user.userId),
  ]);
  const spent30 = byAction.reduce((a, r) => a + r.spent, 0);
  res.json({ balance: balance.balance, spent30d: spent30, byAction: byAction.sort((a, b) => b.spent - a.spent), entries: rows });
});

// ─── Admin ───────────────────────────────────────────────────────────────────
router.put("/admin/sylo/credit/pricing", requireAdmin, async (req, res): Promise<void> => {
  const { priceUsd, priceBdt, minAzn } = (req.body ?? {}) as Record<string, unknown>;
  const usd = num(priceUsd), bdt = num(priceBdt), min = Math.round(num(minAzn));
  if (!(usd > 0) || !(bdt > 0) || !(min >= 1) || usd > 1000 || bdt > 100000) { res.status(400).json({ error: "Invalid price list." }); return; }
  await db.insert(syloCreditPricingTable).values({ id: 1, priceUsd: String(usd), priceBdt: String(bdt), minAzn: min })
    .onConflictDoUpdate({ target: syloCreditPricingTable.id, set: { priceUsd: String(usd), priceBdt: String(bdt), minAzn: min, updatedAt: new Date() } });
  res.json({ ok: true, pricing: { priceUsd: usd, priceBdt: bdt, minAzn: min } });
});

router.get("/admin/sylo/credit/orders", requireAdmin, async (_req, res): Promise<void> => {
  const rows = await db.select().from(syloCreditOrdersTable).where(eq(syloCreditOrdersTable.status, "pending"))
    .orderBy(desc(syloCreditOrdersTable.createdAt)).limit(200);
  res.json({ orders: rows.map(orderJson) });
});

router.post("/admin/sylo/credit/orders/:id/approve", requireAdmin, async (req, res): Promise<void> => {
  const id = idParam(req.params.id);
  if (Number.isNaN(id)) { res.status(404).json({ error: "Not found" }); return; }
  const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 500) : null;
  const done = await db.transaction(async (tx) => {
    // Flip pending -> approved atomically so a double click can never credit twice.
    const [o] = await tx.update(syloCreditOrdersTable)
      .set({ status: "approved", approvedAt: new Date(), adminNote: note, updatedAt: new Date() })
      .where(and(eq(syloCreditOrdersTable.id, id), eq(syloCreditOrdersTable.status, "pending"))).returning();
    if (!o) return null;
    await tx.insert(creditsTable).values({ userId: o.userId }).onConflictDoNothing();
    await tx.update(creditsTable).set({ aznBalance: sql`${creditsTable.aznBalance} + ${num(o.aznAmount)}`, updatedAt: new Date() })
      .where(eq(creditsTable.userId, o.userId));
    await tx.insert(creditTransactionsTable).values({
      userId: o.userId, type: "sylo_azn_purchase", method: o.payKind, credits: 0, aznAmount: num(o.aznAmount),
      amountBDT: o.payKind === "bkash" || o.payKind === "nagad" ? num(o.totalBdt) : null,
      amountUSDT: o.payKind === "binance" || o.payKind === "wallet" ? num(o.totalUsd) : null,
      referenceId: o.referenceId, status: "approved", approvedAt: new Date(), notes: `Sylo order ${o.orderNo}`,
    });
    return o;
  });
  if (!done) { res.status(409).json({ error: "Order not found or already processed." }); return; }
  broadcastEvent("credits_updated", { userId: done.userId, azn: num(done.aznAmount) });
  res.json({ ok: true });
});

router.post("/admin/sylo/credit/orders/:id/reject", requireAdmin, async (req, res): Promise<void> => {
  const id = idParam(req.params.id);
  if (Number.isNaN(id)) { res.status(404).json({ error: "Not found" }); return; }
  const note = typeof req.body?.note === "string" && req.body.note.trim() ? req.body.note.slice(0, 500) : "Rejected by admin";
  const rows = await db.update(syloCreditOrdersTable).set({ status: "rejected", adminNote: note, updatedAt: new Date() })
    .where(and(eq(syloCreditOrdersTable.id, id), eq(syloCreditOrdersTable.status, "pending"))).returning({ id: syloCreditOrdersTable.id });
  if (rows.length === 0) { res.status(409).json({ error: "Order not found or already processed." }); return; }
  res.json({ ok: true });
});

export default router;
