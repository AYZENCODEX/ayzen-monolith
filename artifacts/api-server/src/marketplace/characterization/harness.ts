// MKT-01b test harness (not part of the application; excluded from tsc in tsconfig.json).
// Mounts the REAL Marketplace routers on an Express app over the real @workspace/db pool, which points at the throwaway schema.
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { pool } from "@workspace/db";

if (process.env.DATABASE_URL_TARGET !== "replit-test") {
  throw new Error('Marketplace database tests require DATABASE_URL_TARGET="replit-test".');
}

export { pool };
export interface TestUser { userId: number; role?: "user" | "admin"; username?: string }
export interface Reply { status: number; json: any }

export async function startApp(routers: express.Router[]): Promise<{ base: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  for (const router of routers) app.use(router);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

export async function call(base: string, user: TestUser | null, method: string, path: string, body?: unknown): Promise<Reply> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers["x-test-user"] = JSON.stringify(user);
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

export async function resetTables(): Promise<void> {
  await pool.query(
    "TRUNCATE marketplace_transactions, marketplace_cart_items, marketplace_orders, marketplace_listings, azn_listings, usdt_listings, nft_market_listings, marketplace_wallets, credit_transactions, credits, users RESTART IDENTITY CASCADE",
  );
  (globalThis as any).__mktNotifications = [];
}

export function notifications(): any[][] { return ((globalThis as any).__mktNotifications ?? []) as any[][]; }

export async function createUser(username: string, aznBalance = 0): Promise<number> {
  const u = await pool.query("INSERT INTO users (username) VALUES ($1) RETURNING id", [username]);
  const id = Number(u.rows[0].id);
  await pool.query("INSERT INTO credits (user_id, azn_balance) VALUES ($1, $2)", [id, aznBalance]);
  return id;
}
export async function creditsOf(userId: number): Promise<number | null> {
  const r = await pool.query("SELECT azn_balance FROM credits WHERE user_id=$1", [userId]);
  return r.rows[0] ? Number(r.rows[0].azn_balance) : null;
}
export async function seedP2pListing(sellerId: number, priceAzn: number): Promise<number> {
  const r = await pool.query("INSERT INTO marketplace_listings (seller_id, title, price_azn) VALUES ($1, $2, $3) RETURNING id", [sellerId, "Test listing", priceAzn]);
  return Number(r.rows[0].id);
}
export async function seedWallet(userId: number, marketType: string, balance: number, locked: number): Promise<void> {
  await pool.query("INSERT INTO marketplace_wallets (user_id, market_type, balance, locked_balance) VALUES ($1, $2, $3, $4)", [userId, marketType, balance, locked]);
}
export async function seedAznSellListing(sellerId: number, amount: number, pricePerUnit: number, minBuy = 0): Promise<number> {
  const r = await pool.query(
    "INSERT INTO azn_listings (seller_id, amount, price_per_unit, total_price, min_buy, order_type) VALUES ($1, $2, $3, $4, $5, 'sell') RETURNING id",
    [sellerId, amount, pricePerUnit, amount * pricePerUnit, minBuy],
  );
  return Number(r.rows[0].id);
}
export async function seedNftListing(sellerId: number, price: number): Promise<number> {
  const r = await pool.query("INSERT INTO nft_market_listings (seller_id, name, price) VALUES ($1, $2, $3) RETURNING id", [sellerId, "Test NFT", price]);
  return Number(r.rows[0].id);
}
export async function walletOf(userId: number, marketType: string): Promise<{ balance: number; locked: number } | null> {
  const r = await pool.query("SELECT balance, locked_balance FROM marketplace_wallets WHERE user_id=$1 AND market_type=$2", [userId, marketType]);
  return r.rows[0] ? { balance: Number(r.rows[0].balance), locked: Number(r.rows[0].locked_balance) } : null;
}
export async function seedUsdtSellListing(sellerId: number, amount: number, pricePerUnit: number, minBuy = 0): Promise<number> {
  const r = await pool.query(
    "INSERT INTO usdt_listings (seller_id, amount, price_per_unit, total_price, min_buy, order_type) VALUES ($1, $2, $3, $4, $5, 'sell') RETURNING id",
    [sellerId, amount, pricePerUnit, amount * pricePerUnit, minBuy],
  );
  return Number(r.rows[0].id);
}
export async function seedCartItem(userId: number, listingId: number, priceAzn: number, saved = false): Promise<void> {
  await pool.query("INSERT INTO marketplace_cart_items (user_id, listing_id, price_azn, saved) VALUES ($1, $2, $3, $4)", [userId, listingId, priceAzn, saved]);
}
export const near = (a: number, b: number, eps = 1e-4): boolean => Math.abs(a - b) <= eps;
