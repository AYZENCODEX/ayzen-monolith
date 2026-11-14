/**
 * lib/module-password.ts — W1-P2: password hashing for per-module credentials (argon2id).
 *
 * Uses Node's built-in `crypto.argon2` (Node >= 24.7; the repo pins Node 24 in .nvmrc and CI), so there is
 * no native dependency to build. It runs on the libuv thread pool, so hashing does not block the event loop.
 *
 * Hashes are PHC strings:  $argon2id$v=19$m=<KiB>,t=<passes>,p=<lanes>$<salt b64>$<tag b64>   (no padding)
 * The central AYZEN account keeps bcrypt (lib/password.ts); the two stores never share hashes.
 *
 * Defaults follow the OWASP minimum for argon2id (m=19 MiB, t=2, p=1). Override with
 * MODULE_ARGON2_MEMORY_KIB / MODULE_ARGON2_PASSES; a stored hash made with older parameters still verifies and
 * `needsRehash()` reports it so the login path can upgrade it.
 */
import { argon2 as argon2Cb, randomBytes, createHash, timingSafeEqual } from "node:crypto";

export interface Argon2Params { memoryKib: number; passes: number; parallelism: number }

const TAG_LENGTH = 32;
const SALT_LENGTH = 16;
// Upper bounds applied when VERIFYING a stored hash, so a corrupted/hostile row cannot make a login allocate gigabytes.
const MAX_MEMORY_KIB = 262_144; // 256 MiB
const MAX_PASSES = 10;
const MAX_PARALLELISM = 4;

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 128;

function envInt(name: string, fallback: number, min: number, max: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export function currentParams(env: NodeJS.ProcessEnv = process.env): Argon2Params {
  return {
    memoryKib: envInt("MODULE_ARGON2_MEMORY_KIB", 19_456, 8, MAX_MEMORY_KIB, env),
    passes: envInt("MODULE_ARGON2_PASSES", 2, 1, MAX_PASSES, env),
    parallelism: 1,
  };
}

const b64 = (buf: Buffer) => buf.toString("base64").replace(/=+$/, "");
const fromB64 = (s: string) => Buffer.from(s, "base64");

function derive(password: string, salt: Buffer, p: Argon2Params): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2Cb(
      "argon2id",
      { message: Buffer.from(password, "utf8"), nonce: salt, parallelism: p.parallelism, tagLength: TAG_LENGTH, memory: p.memoryKib, passes: p.passes },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

export async function hashModulePassword(password: string, params: Argon2Params = currentParams()): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const tag = await derive(password, salt, params);
  return `$argon2id$v=19$m=${params.memoryKib},t=${params.passes},p=${params.parallelism}$${b64(salt)}$${b64(tag)}`;
}

interface Parsed { params: Argon2Params; salt: Buffer; tag: Buffer }

export function parsePhc(hash: string): Parsed | null {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(hash);
  if (!m) return null;
  const params = { memoryKib: Number(m[1]), passes: Number(m[2]), parallelism: Number(m[3]) };
  if (params.memoryKib < 8 || params.memoryKib > MAX_MEMORY_KIB) return null;
  if (params.passes < 1 || params.passes > MAX_PASSES) return null;
  if (params.parallelism < 1 || params.parallelism > MAX_PARALLELISM) return null;
  const salt = fromB64(m[4]);
  const tag = fromB64(m[5]);
  if (salt.length < 8 || tag.length < 16 || tag.length > 64) return null;
  return { params, salt, tag };
}

/** Constant-time verify. Returns false (never throws) for a malformed hash, wrong password or any internal error. */
export async function verifyModulePassword(password: string, storedHash: string): Promise<boolean> {
  const parsed = parsePhc(storedHash);
  if (!parsed) return false;
  try {
    const candidate = await derive(password, parsed.salt, parsed.params);
    // derive() always yields TAG_LENGTH bytes; a stored tag of another length can never match (and timingSafeEqual would throw).
    return candidate.length === parsed.tag.length && timingSafeEqual(candidate, parsed.tag);
  } catch {
    return false;
  }
}

export function modulePasswordNeedsRehash(storedHash: string, target: Argon2Params = currentParams()): boolean {
  const parsed = parsePhc(storedHash);
  if (!parsed) return true;
  return parsed.params.memoryKib < target.memoryKib || parsed.params.passes < target.passes || parsed.params.parallelism !== target.parallelism || parsed.tag.length !== TAG_LENGTH;
}

let dummyHash: Promise<string> | null = null;
/**
 * Burns the same CPU as a real verification. Call when the identifier does not exist (or the account is locked) so
 * response time does not reveal which identifiers have accounts.
 */
export async function burnVerificationTime(password: string): Promise<void> {
  dummyHash ??= hashModulePassword("not-a-real-password-for-timing-only");
  await verifyModulePassword(password, await dummyHash);
}

// ─── Password policy ─────────────────────────────────────────────────────────

export type PasswordPolicyResult = { ok: true } | { ok: false; code: "PASSWORD_TOO_SHORT" | "PASSWORD_TOO_LONG" | "PASSWORD_EQUALS_IDENTIFIER" | "PASSWORD_TOO_SIMPLE" };

/** Length-based policy (NIST 800-63B style): no composition rules, but reject trivial repeats and the identifier itself. */
export function checkPasswordPolicy(password: unknown, identifier: string): PasswordPolicyResult {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) return { ok: false, code: "PASSWORD_TOO_SHORT" };
  if (password.length > MAX_PASSWORD_LENGTH) return { ok: false, code: "PASSWORD_TOO_LONG" };
  const lower = password.toLowerCase();
  const ident = identifier.trim().toLowerCase();
  if (lower === ident || lower === ident.split("@")[0]) return { ok: false, code: "PASSWORD_EQUALS_IDENTIFIER" };
  if (new Set(password).size < 4) return { ok: false, code: "PASSWORD_TOO_SIMPLE" };
  return { ok: true };
}

// ─── Reset tokens ────────────────────────────────────────────────────────────

/** 256-bit random token for the reset email; only its sha256 is stored. */
export function newResetToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashResetToken(token) };
}

export function hashResetToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
