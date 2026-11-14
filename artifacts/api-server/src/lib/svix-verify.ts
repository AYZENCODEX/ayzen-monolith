/**
 * lib/svix-verify.ts — W1-P5: verification of a Svix-signed webhook (Clerk sends webhooks through Svix).
 * signed content = `${svix-id}.${svix-timestamp}.${raw body}`, HMAC-SHA256 with the base64 part of `whsec_<base64>`,
 * delivered base64 in `svix-signature` as space-separated `v1,<sig>` entries (several during secret rotation).
 * Pure: the raw body string is passed in; time is injectable.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type SvixResult = { ok: true } | { ok: false; reason: "missing_header" | "bad_secret" | "bad_timestamp" | "stale" | "bad_signature" };

export function verifySvixSignature(input: {
  secret: string; id: string | undefined; timestamp: string | undefined; signature: string | undefined; body: string;
  nowMs?: number; toleranceSeconds?: number;
}): SvixResult {
  const { id, timestamp, signature } = input;
  if (!id || !timestamp || !signature) return { ok: false, reason: "missing_header" };
  const key = Buffer.from(input.secret.startsWith("whsec_") ? input.secret.slice(6) : input.secret, "base64");
  if (key.length === 0) return { ok: false, reason: "bad_secret" };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "bad_timestamp" };
  const tolerance = input.toleranceSeconds ?? 300;
  const now = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (Math.abs(now - Number(timestamp)) > tolerance) return { ok: false, reason: "stale" };
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${input.body}`).digest();
  for (const part of signature.split(" ")) {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) continue;
    const got = Buffer.from(sig, "base64");
    if (got.length === expected.length && timingSafeEqual(got, expected)) return { ok: true };
  }
  return { ok: false, reason: "bad_signature" };
}
