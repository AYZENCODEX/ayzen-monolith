import { pgTable, serial, text, integer, jsonb, timestamp, index, unique } from "drizzle-orm/pg-core";

/**
 * Durable request idempotency records shared by API writes and extracted
 * service adapters. Response bodies are retained only for the configured TTL
 * so a retried request can receive the original result without repeating the
 * business mutation.
 */
export const idempotencyKeysTable = pgTable("idempotency_keys", {
  id: serial("id").primaryKey(),
  scope: text("scope").notNull(),
  key: text("key").notNull(),
  requestHash: text("request_hash").notNull(),
  status: text("status").notNull().default("PROCESSING"),
  responseCode: integer("response_code"),
  responseBody: jsonb("response_body").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
}, (t) => ({
  scopeKeyUnique: unique().on(t.scope, t.key),
  expiryIdx: index("idx_idempotency_keys_expiry").on(t.expiresAt),
}));

export type IdempotencyKeyRow = typeof idempotencyKeysTable.$inferSelect;

export const serviceRequestNoncesTable = pgTable("service_request_nonces", {
  id: serial("id").primaryKey(),
  service: text("service").notNull(),
  requestId: text("request_id").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  serviceRequestUnique: unique().on(t.service, t.requestId),
  expiryIdx: index("idx_service_request_nonces_expiry").on(t.expiresAt),
}));