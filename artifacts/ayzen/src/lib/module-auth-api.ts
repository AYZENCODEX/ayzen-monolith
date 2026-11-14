/**
 * lib/module-auth-api.ts — W1-P2/W1-P4 browser client for the host-scoped module auth routes
 * (artifacts/api-server/src/routes/module-auth.ts). Every call goes to the module's own host / the API base with credentials
 * included, so the per-module `__Host-` cookie is set by the response. All helpers are plain functions over an injectable
 * `fetchImpl`, so they are testable without a browser.
 */
import { getApiBase } from "./api-base";
import type { SessionExchangeResult } from "./sylo-oidc-callback";

export interface ModuleAuthOptions {
  module: string;
  label: string;
  /** Email + password module credentials (W1-P2). */
  password: boolean;
  signup: boolean;
  /** "Login with AYZEN" is rolled out for this module (the per-module OIDC rollout flag). */
  oidc: boolean;
  /** Social sign-in (Google / Facebook / GitHub through this module's own Clerk application, W1-P5) is configured. */
  social: boolean;
}

export class ModuleAuthError extends Error {
  constructor(public readonly code: string, message: string, public readonly solution?: string) {
    super(message);
    this.name = "ModuleAuthError";
  }
}

type Fetch = typeof fetch;
// `import.meta.env` does not exist outside Vite (tests, SSR): fall back to same-origin there.
const apiBase = (): string => { try { return getApiBase(); } catch { return ""; } };
const url = (path: string) => `${apiBase()}/api/auth/module${path}`;

async function post(fetchImpl: Fetch, path: string, body: unknown, token?: string): Promise<any> {
  const res = await fetchImpl(url(path), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ModuleAuthError(String(data?.code ?? `HTTP_${res.status}`), String(data?.error ?? "Request failed"), data?.solution);
  return data;
}

/** `null` when module sessions are off (404) or the host is not a module host: the caller uses the legacy login. */
export async function getModuleAuthOptions(fetchImpl: Fetch = fetch): Promise<ModuleAuthOptions | null> {
  try {
    const res = await fetchImpl(url("/options"), { credentials: "include" });
    if (!res.ok) return null;
    const d = await res.json();
    if (typeof d?.module !== "string") return null;
    return { module: d.module, label: String(d.label ?? d.module), password: d.password === true, signup: d.signup === true, oidc: d.oidc === true, social: d.social === true };
  } catch {
    return null;
  }
}

/** The SPA's auth context wants a full user object; the module routes return a token. `/auth/me` accepts a module token. */
async function userFor(token: string, fetchImpl: Fetch): Promise<SessionExchangeResult["user"]> {
  const res = await fetchImpl(`${apiBase()}/api/auth/me`, { credentials: "include", headers: { Authorization: `Bearer ${token}` } });
  const user = await res.json().catch(() => null);
  if (!res.ok || !user?.id) throw new ModuleAuthError("USER_LOOKUP_FAILED", "Signed in, but your profile could not be loaded.");
  return user;
}

export async function moduleLogin(identifier: string, password: string, fetchImpl: Fetch = fetch): Promise<SessionExchangeResult> {
  const d = await post(fetchImpl, "/login", { email: identifier, password });
  return { token: d.token, user: await userFor(d.token, fetchImpl) };
}

export async function moduleSignup(identifier: string, password: string, fetchImpl: Fetch = fetch): Promise<SessionExchangeResult> {
  const d = await post(fetchImpl, "/signup", { email: identifier, password });
  return { token: d.token, user: await userFor(d.token, fetchImpl) };
}

/**
 * "Login with AYZEN": hands the OIDC access token (proof of the AYZEN identity) to the module and gets a module session.
 * With `link` it attaches that identity to an existing module account (flow 3).
 */
export async function exchangeModuleOidcSession(
  accessToken: string,
  link?: { identifier: string; password: string },
  fetchImpl: Fetch = fetch,
): Promise<SessionExchangeResult> {
  const d = await post(fetchImpl, "/oidc", { access_token: accessToken, ...(link ? { link } : {}) });
  return { token: d.token, user: await userFor(d.token, fetchImpl), ayzenUserId: typeof d.ayzenUserId === "number" ? d.ayzenUserId : undefined };
}

/**
 * W1-P5: hands the module's own Clerk session token to the module and gets a module session. The server verifies it against
 * this module's Clerk application only; a token from another module's pool is refused.
 */
export async function exchangeModuleClerkSession(sessionToken: string, fetchImpl: Fetch = fetch): Promise<SessionExchangeResult & { created: boolean }> {
  const d = await post(fetchImpl, "/clerk", { session_token: sessionToken });
  return { token: d.token, created: d.created === true, user: await userFor(d.token, fetchImpl) };
}
