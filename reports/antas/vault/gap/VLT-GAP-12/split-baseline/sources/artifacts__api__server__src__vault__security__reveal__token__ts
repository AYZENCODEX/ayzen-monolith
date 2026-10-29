import { randomBytes } from "node:crypto";
import { getRow } from "../infrastructure/repositories/vault-security-repository";

export const REVEAL_TOKEN_TTL_MS = 45_000;
const revealTokens = new Map<number, { token: string; expiresAt: number }>();

export function mintRevealToken(userId: number): string {
  const token = randomBytes(24).toString("hex");
  revealTokens.set(userId, { token, expiresAt: Date.now() + REVEAL_TOKEN_TTL_MS });
  return token;
}

/** Single-use: a valid token is consumed (deleted) the moment it's checked, pass or fail. */
export function consumeRevealToken(userId: number, token: string | undefined | null): boolean {
  const entry = revealTokens.get(userId);
  if (!entry) return false;
  revealTokens.delete(userId);
  if (!token) return false;
  if (Date.now() > entry.expiresAt) return false;
  return entry.token === token;
}

/** True if this user currently has no entity PIN set — the seed route treats that as "nothing to gate on", matching every other entity-PIN check in the app. */
export async function hasNoEntityPin(userId: number): Promise<boolean> {
  const row = await getRow(userId);
  return !row?.entityPinHash;
}