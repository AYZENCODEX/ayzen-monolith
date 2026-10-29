import crypto from "node:crypto";
import { db, idempotencyKeysTable } from "@workspace/db";
import { and, eq, lt } from "drizzle-orm";

export type IdempotencyBeginResult =
  | { kind: "started"; scope: string; key: string }
  | { kind: "replay"; statusCode: number; body: Record<string, unknown> }
  | { kind: "in-flight" }
  | { kind: "conflict" };

function requestHash(input: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(input ?? null)).digest("hex");
}

export async function beginIdempotentRequest(
  scope: string,
  key: string,
  input: unknown,
  ttlMs = 24 * 60 * 60 * 1000,
): Promise<IdempotencyBeginResult> {
  const normalizedKey = key.trim();
  if (!normalizedKey || normalizedKey.length > 255) throw new Error("Idempotency-Key must be 1-255 characters");
  const hash = requestHash(input);
  const expiresAt = new Date(Date.now() + ttlMs);

  await db.delete(idempotencyKeysTable).where(lt(idempotencyKeysTable.expiresAt, new Date()));
  const inserted = await db.insert(idempotencyKeysTable).values({
    scope, key: normalizedKey, requestHash: hash, expiresAt,
  }).onConflictDoNothing().returning({ id: idempotencyKeysTable.id });
  if (inserted.length) return { kind: "started", scope, key: normalizedKey };

  const [existing] = await db.select().from(idempotencyKeysTable).where(and(
    eq(idempotencyKeysTable.scope, scope),
    eq(idempotencyKeysTable.key, normalizedKey),
  )).limit(1);
  if (!existing || existing.requestHash !== hash) return { kind: "conflict" };
  if (existing.status === "COMPLETED" && existing.responseCode && existing.responseBody) {
    return { kind: "replay", statusCode: existing.responseCode, body: existing.responseBody };
  }
  return { kind: "in-flight" };
}

export async function completeIdempotentRequest(
  scope: string,
  key: string,
  statusCode: number,
  body: Record<string, unknown>,
): Promise<void> {
  await db.update(idempotencyKeysTable).set({
    status: "COMPLETED",
    responseCode: statusCode,
    responseBody: body,
  }).where(and(eq(idempotencyKeysTable.scope, scope), eq(idempotencyKeysTable.key, key)));
}

export async function failIdempotentRequest(scope: string, key: string): Promise<void> {
  await db.delete(idempotencyKeysTable).where(and(
    eq(idempotencyKeysTable.scope, scope),
    eq(idempotencyKeysTable.key, key),
  ));
}