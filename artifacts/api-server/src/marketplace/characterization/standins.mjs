// MKT-01b: minimal stand-ins for tables the Marketplace routes touch but Marketplace does not own. They live in the
// throwaway schema and are dropped with it. Columns are exactly those the tested statements read or write; the real tables
// (Drizzle schema in lib/db) have more. Shared by the DB runner and the static fixture check.
export const STAND_INS = {
  users: `CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username TEXT,
  role TEXT NOT NULL DEFAULT 'user'
)`,
  credits: `CREATE TABLE credits (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE,
  balance INTEGER NOT NULL DEFAULT 0,
  azn_balance REAL NOT NULL DEFAULT 0,
  total_purchased INTEGER NOT NULL DEFAULT 0,
  total_spent INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
)`,
  credit_transactions: `CREATE TABLE credit_transactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  azn_amount REAL NOT NULL DEFAULT 0,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
)`,
};
// Marketplace tables the 01b-1 suite needs (created from the application's own DDL in lib/schema-migrations.ts).
export const SCOPE_TABLE_PATTERN = /^(marketplace_[a-z_]+|spot_orders|spot_trades|staking_pools|staking_positions|azn_listings|usdt_listings|nft_market_[a-z_]+)$/;
export const TRUNCATE_ORDER = ["marketplace_transactions", "marketplace_cart_items", "marketplace_orders", "marketplace_listings", "azn_listings", "usdt_listings", "nft_market_listings", "marketplace_wallets", "credit_transactions", "credits", "users"];
