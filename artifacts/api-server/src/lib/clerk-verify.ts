/**
 * lib/clerk-verify.ts — W1-P5: verifies a Clerk SESSION TOKEN (RS256 JWT) against ONE module's Clerk application.
 *
 * Checks, all required: structure + alg RS256 + kid; signature against that application's JWKS (cached, refetched once per
 * cooldown on an unknown kid so key rotation works without a restart and a flood of junk kids cannot hammer the JWKS endpoint);
 * `iss` equals the module's configured issuer exactly; `exp` and `nbf` with 30 s leeway; `azp` (the origin that asked Clerk
 * for the token) is one of the module's own origins; `sub` is a Clerk user id. Because the issuer AND the key set come from the
 * module being logged in to, a token minted by any other module's Clerk application fails (different issuer, different keys).
 * Uses node:crypto only; `fetchJwks` and the clock are injectable so it is testable without a network.
 */
import { createPublicKey, createVerify } from "node:crypto";
import type { ClerkModuleConfig } from "./clerk-config";

export interface ClerkClaims { sub: string; sid?: string; email?: string; emailVerified: boolean; azp: string; exp: number; iat?: number }
export type ClerkVerifyResult =
  | { ok: true; claims: ClerkClaims }
  | { ok: false; reason: "malformed" | "bad_alg" | "unknown_kid" | "bad_signature" | "bad_issuer" | "expired" | "not_yet_valid" | "bad_azp" | "bad_subject" | "jwks_unavailable" };

type Jwk = { kid?: string; kty?: string; n?: string; e?: string; [k: string]: unknown };
export type FetchJwks = (url: string) => Promise<{ keys: Jwk[] }>;

const LEEWAY_SECONDS = 30;
const JWKS_TTL_MS = 60 * 60 * 1000;
const REFETCH_COOLDOWN_MS = 30 * 1000;
const MAX_TOKEN_CHARS = 8192;

interface CacheEntry { keys: Jwk[]; fetchedAt: number }
const cache = new Map<string, CacheEntry>();
export const __resetClerkJwksCacheForTests = (): void => cache.clear();

async function defaultFetchJwks(url: string): Promise<{ keys: Jwk[] }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`JWKS HTTP ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  if (!Array.isArray(body.keys)) throw new Error("JWKS has no keys");
  return { keys: body.keys };
}

async function keyFor(cfg: ClerkModuleConfig, kid: string, fetchJwks: FetchJwks, now: number): Promise<Jwk | null | "unavailable"> {
  let entry = cache.get(cfg.jwksUrl);
  const find = (e: CacheEntry | undefined) => e?.keys.find((k) => k.kid === kid && k.kty === "RSA") ?? null;
  if (entry && now - entry.fetchedAt < JWKS_TTL_MS && find(entry)) return find(entry);
  // Missing/expired cache, or an unknown kid: refetch, but not more often than the cooldown.
  if (!entry || now - entry.fetchedAt >= REFETCH_COOLDOWN_MS) {
    try {
      const fresh = await fetchJwks(cfg.jwksUrl);
      entry = { keys: fresh.keys, fetchedAt: now };
      cache.set(cfg.jwksUrl, entry);
    } catch {
      return entry && find(entry) ? find(entry) : "unavailable";
    }
  }
  return find(entry);
}

const b64urlJson = (s: string): any => { try { return JSON.parse(Buffer.from(s, "base64url").toString("utf8")); } catch { return null; } };

export async function verifyClerkSessionToken(
  token: unknown, cfg: ClerkModuleConfig, deps: { fetchJwks?: FetchJwks; nowMs?: number } = {},
): Promise<ClerkVerifyResult> {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_CHARS) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return { ok: false, reason: "malformed" };
  const header = b64urlJson(parts[0]);
  const claims = b64urlJson(parts[1]);
  if (!header || !claims || typeof claims !== "object") return { ok: false, reason: "malformed" };
  if (header.alg !== "RS256") return { ok: false, reason: "bad_alg" }; // never "none", never HS256
  if (typeof header.kid !== "string" || header.kid.length > 200) return { ok: false, reason: "unknown_kid" };

  const nowMs = deps.nowMs ?? Date.now();
  const jwk = await keyFor(cfg, header.kid, deps.fetchJwks ?? defaultFetchJwks, nowMs);
  if (jwk === "unavailable") return { ok: false, reason: "jwks_unavailable" };
  if (!jwk) return { ok: false, reason: "unknown_kid" };

  let valid = false;
  try {
    valid = createVerify("RSA-SHA256").update(`${parts[0]}.${parts[1]}`).verify(createPublicKey({ key: jwk as any, format: "jwk" }), Buffer.from(parts[2], "base64url"));
  } catch { valid = false; }
  if (!valid) return { ok: false, reason: "bad_signature" };

  const now = Math.floor(nowMs / 1000);
  if (claims.iss !== cfg.issuer) return { ok: false, reason: "bad_issuer" };
  if (typeof claims.exp !== "number" || claims.exp + LEEWAY_SECONDS < now) return { ok: false, reason: "expired" };
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf - LEEWAY_SECONDS > now)) return { ok: false, reason: "not_yet_valid" };
  if (typeof claims.azp !== "string" || !cfg.authorizedParties.includes(claims.azp)) return { ok: false, reason: "bad_azp" };
  if (typeof claims.sub !== "string" || !/^user_[A-Za-z0-9]{8,64}$/.test(claims.sub)) return { ok: false, reason: "bad_subject" };

  return {
    ok: true,
    claims: {
      sub: claims.sub, azp: claims.azp, exp: claims.exp,
      ...(typeof claims.sid === "string" ? { sid: claims.sid } : {}),
      ...(typeof claims.iat === "number" ? { iat: claims.iat } : {}),
      ...(typeof claims.email === "string" ? { email: claims.email.slice(0, 320) } : {}),
      emailVerified: claims.email_verified === true,
    },
  };
}
