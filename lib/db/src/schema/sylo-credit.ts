import { pgTable, serial, integer, text, boolean, timestamp, numeric } from "drizzle-orm/pg-core";

/** Sylo credit storefront (migrations/131_sylo_credit.sql). Balances stay in `credits.azn_balance`. */

export const syloPaymentMethodsTable = pgTable("sylo_payment_methods", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  kind: text("kind").notNull(), // bkash | nagad | binance | wallet
  label: text("label"),
  account: text("account").notNull(), // mobile number, Binance Pay ID, or wallet address
  network: text("network"), // wallet only, e.g. TRC20
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const syloCreditPricingTable = pgTable("sylo_credit_pricing", {
  id: integer("id").primaryKey(), // always 1
  priceUsd: numeric("price_usd", { precision: 12, scale: 6 }).notNull().default("0.01"),
  priceBdt: numeric("price_bdt", { precision: 12, scale: 4 }).notNull().default("1.27"),
  minAzn: integer("min_azn").notNull().default(100),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const syloCreditOrdersTable = pgTable("sylo_credit_orders", {
  id: serial("id").primaryKey(),
  orderNo: text("order_no").notNull().unique(),
  userId: integer("user_id").notNull(),
  aznAmount: numeric("azn_amount", { precision: 18, scale: 4 }).notNull(),
  unitPriceUsd: numeric("unit_price_usd", { precision: 12, scale: 6 }).notNull(),
  unitPriceBdt: numeric("unit_price_bdt", { precision: 12, scale: 4 }).notNull(),
  totalUsd: numeric("total_usd", { precision: 18, scale: 4 }).notNull(),
  totalBdt: numeric("total_bdt", { precision: 18, scale: 2 }).notNull(),
  payKind: text("pay_kind").notNull(),
  payAccount: text("pay_account").notNull(),
  paymentMethodId: integer("payment_method_id"),
  referenceId: text("reference_id").notNull(),
  status: text("status").notNull().default("pending"), // pending | approved | rejected
  adminNote: text("admin_note"),
  approvedAt: timestamp("approved_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type SyloPaymentMethodRow = typeof syloPaymentMethodsTable.$inferSelect;
export type SyloCreditOrderRow = typeof syloCreditOrdersTable.$inferSelect;
