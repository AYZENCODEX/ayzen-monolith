/**
 * lib/module-session-policy.ts — W1-P2 (req 7, ADR A4): per-module sessions.
 *
 * Pure decisions, no I/O, no database, no Express: the one place that says
 *   - which cookie carries a module session (`__Host-<module>_sid`, host-only),
 *   - which module a request is "in" (the module that owns the Host header),
 *   - whether a token may be used there.
 *
 * ISOLATION RULE. A session minted for module A is valid only on A's own host. On any other host —
 * another module, the central app, an API host, or no request at all — it is rejected (401). The check
 * is on the token's `mod` claim against the module of the request's Host, never on anything the client
 * chooses (Origin, a header, a query parameter).
 *
 * ROLLOUT FLAG  MODULE_SESSIONS_MODE
 *   off    (default) Module sessions are disabled: a token carrying `mod` is rejected everywhere, the
 *          module auth routes answer 404, and every existing session behaves exactly as before.
 *          This is also the KILL SWITCH — flip to `off` and every module session stops working at once.
 *   dual   Module sessions work. The old shared `*.ayzen.tech` session (no `mod`) is still accepted on
 *          module hosts until MODULE_SESSIONS_LEGACY_UNTIL (grace period; unset = no deadline).
 *   strict Module sessions work. Shared sessions are no longer accepted on module hosts.
 * An unrecognised value is treated as `off` (fail closed for module sessions) and reported via `invalid`.
 */
import { MODULES, type ModuleId } from "@ayzen/module-registry";
import { getSharedAppForHost } from "./shared-apps";

export type ModuleSessionsMode = "off" | "dual" | "strict";

export interface ModuleSessionsConfig {
  mode: ModuleSessionsMode;
  /** In `dual` mode, shared sessions are accepted on module hosts strictly before this instant. null = no deadline. */
  legacyUntil: Date | null;
  /** Set when an env var held something unusable; the config then fell back to the safe value. */
  invalid?: string[];
}

export function readModuleSessionsConfig(env: NodeJS.ProcessEnv = process.env): ModuleSessionsConfig {
  const invalid: string[] = [];
  const rawMode = (env.MODULE_SESSIONS_MODE ?? "").trim().toLowerCase();
  let mode: ModuleSessionsMode = "off";
  if (rawMode === "dual" || rawMode === "strict" || rawMode === "off") mode = rawMode;
  else if (rawMode !== "") invalid.push(`MODULE_SESSIONS_MODE=${JSON.stringify(env.MODULE_SESSIONS_MODE)}`);

  let legacyUntil: Date | null = null;
  const rawUntil = (env.MODULE_SESSIONS_LEGACY_UNTIL ?? "").trim();
  if (rawUntil !== "") {
    const parsed = new Date(rawUntil);
    if (Number.isNaN(parsed.getTime())) {
      // An unusable deadline must not silently extend the grace period forever: treat it as "already over".
      legacyUntil = new Date(0);
      invalid.push(`MODULE_SESSIONS_LEGACY_UNTIL=${JSON.stringify(env.MODULE_SESSIONS_LEGACY_UNTIL)}`);
    } else {
      legacyUntil = parsed;
    }
  }
  return { mode, legacyUntil, ...(invalid.length ? { invalid } : {}) };
}

export function isModuleSessionsEnabled(config: ModuleSessionsConfig = readModuleSessionsConfig()): boolean {
  return config.mode !== "off";
}

/** Are shared (non-module) sessions still accepted on a module host right now? */
export function legacySessionsAcceptedOnModuleHosts(config: ModuleSessionsConfig, now: Date = new Date()): boolean {
  if (config.mode === "off") return true; // feature off: nothing about existing behaviour changes
  if (config.mode === "strict") return false;
  return config.legacyUntil === null || now.getTime() < config.legacyUntil.getTime();
}

// ─── Cookie ──────────────────────────────────────────────────────────────────

/**
 * `__Host-sylo_sid` in production: the `__Host-` prefix makes the browser require Secure, Path=/ and NO Domain
 * attribute, so the cookie is host-only and cannot be set or overwritten from a sibling subdomain. Outside production
 * (plain http on localhost, where a Secure cookie is refused by some browsers) the prefix is dropped: `sylo_sid`.
 */
export function moduleCookieName(module: ModuleId, hostPrefix: boolean = process.env.NODE_ENV === "production"): string {
  return `${hostPrefix ? "__Host-" : ""}${module}_sid`;
}

/** The legacy shared cookie (lib/session-cookie.ts AYZEN_SESSION_COOKIE); repeated here to stay dependency-free. */
export const LEGACY_SESSION_COOKIE = "ayzen_session";

// ─── Request module ──────────────────────────────────────────────────────────

/** The module that owns this Host header, or null for the central app, API hosts and unknown hosts. */
export function resolveRequestModule(hostname: string | undefined | null): ModuleId | null {
  const app = getSharedAppForHost(hostname ?? undefined);
  return app ? (app.id as ModuleId) : null;
}

const MODULE_ID_SET: ReadonlySet<string> = new Set(MODULES.map((m) => m.id));
export const isKnownModuleId = (value: unknown): value is ModuleId => typeof value === "string" && MODULE_ID_SET.has(value);

// ─── Which cookie to read ────────────────────────────────────────────────────

export interface SelectedSessionToken {
  token: string;
  source: "module" | "legacy";
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/**
 * Picks the session token out of a request's cookies. On a module host the module's own cookie wins; the
 * shared cookie is only a fallback while shared sessions are still accepted there. Off a module host (or
 * with the feature off) it is the shared cookie only, exactly as before this phase.
 * Another module's cookie is never read: its name is derived from the request's own module.
 */
export function selectSessionToken(input: {
  contextModule: ModuleId | null;
  cookies: Record<string, unknown> | undefined;
  config: ModuleSessionsConfig;
  now?: Date;
  hostPrefix?: boolean;
}): SelectedSessionToken | null {
  const { contextModule, cookies, config } = input;
  const legacy = cookies?.[LEGACY_SESSION_COOKIE];
  if (contextModule === null || config.mode === "off") {
    return nonEmpty(legacy) ? { token: legacy, source: "legacy" } : null;
  }
  const own = cookies?.[moduleCookieName(contextModule, input.hostPrefix)];
  if (nonEmpty(own)) return { token: own, source: "module" };
  if (nonEmpty(legacy) && legacySessionsAcceptedOnModuleHosts(config, input.now)) return { token: legacy, source: "legacy" };
  return null;
}

// ─── May this token be used here? ────────────────────────────────────────────

export type ModuleAccessDenyCode =
  | "MODULE_SESSIONS_DISABLED"
  | "MODULE_SESSION_NO_CONTEXT"
  | "MODULE_SESSION_WRONG_MODULE"
  | "LEGACY_SESSION_NOT_ACCEPTED_ON_MODULE_HOST";

export type ModuleAccessDecision = { allow: true } | { allow: false; code: ModuleAccessDenyCode };

/**
 * @param tokenModule   the `mod` claim of the verified token, or null for a shared (central) session token
 * @param contextModule the module the request's Host belongs to, or null (central / API host / non-HTTP caller)
 */
export function decideTokenModuleAccess(input: {
  tokenModule: ModuleId | null;
  contextModule: ModuleId | null;
  config: ModuleSessionsConfig;
  now?: Date;
}): ModuleAccessDecision {
  const { tokenModule, contextModule, config } = input;
  if (tokenModule !== null) {
    if (config.mode === "off") return { allow: false, code: "MODULE_SESSIONS_DISABLED" };
    if (contextModule === null) return { allow: false, code: "MODULE_SESSION_NO_CONTEXT" };
    if (contextModule !== tokenModule) return { allow: false, code: "MODULE_SESSION_WRONG_MODULE" };
    return { allow: true };
  }
  // A shared session token. Off a module host nothing changes.
  if (contextModule === null) return { allow: true };
  if (legacySessionsAcceptedOnModuleHosts(config, input.now)) return { allow: true };
  return { allow: false, code: "LEGACY_SESSION_NOT_ACCEPTED_ON_MODULE_HOST" };
}

// ─── Token claims ────────────────────────────────────────────────────────────

/**
 * Validates the module claims of a decoded token. `mod` and `mac` (module account id) must appear together
 * and be well formed; anything else is a malformed token and the caller must reject it outright.
 */
export function parseModuleClaims(decoded: Record<string, unknown>):
  | { ok: true; mod: ModuleId; mac: number }
  | { ok: true; mod: null; mac: null }
  | { ok: false } {
  const hasMod = decoded.mod !== undefined;
  const hasMac = decoded.mac !== undefined;
  if (!hasMod && !hasMac) return { ok: true, mod: null, mac: null };
  if (!hasMod || !hasMac) return { ok: false };
  if (!isKnownModuleId(decoded.mod)) return { ok: false };
  if (typeof decoded.mac !== "number" || !Number.isSafeInteger(decoded.mac) || decoded.mac < 1) return { ok: false };
  return { ok: true, mod: decoded.mod, mac: decoded.mac };
}
