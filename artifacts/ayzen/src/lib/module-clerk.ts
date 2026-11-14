/**
 * lib/module-clerk.ts — W1-P5 browser side of "social login through Clerk", one Clerk application per module.
 *
 * Each module host builds with its OWN publishable key (VITE_CLERK_<MODULE>_PUBLISHABLE_KEY) and so talks to its own Clerk
 * application / user pool; there is no shared key and no cross-module Clerk SSO. Clerk's script is loaded from the
 * Frontend API host that is encoded inside the publishable key (no npm dependency, and the host can only ever be the
 * module's own Clerk instance). The Clerk session is used once — to prove the social identity to /api/auth/module/clerk —
 * and is then signed out of Clerk: the module's own session is the only session the app keeps.
 *
 * UNVERIFIED against a live Clerk instance (no keys in CI); the pure helpers below are unit-tested.
 */
export const SOCIAL_PROVIDERS = [
  { id: "google", label: "Google", strategy: "oauth_google" },
  { id: "facebook", label: "Facebook", strategy: "oauth_facebook" },
  { id: "github", label: "GitHub", strategy: "oauth_github" },
] as const;
export type SocialProviderId = (typeof SOCIAL_PROVIDERS)[number]["id"];
export const CLERK_CALLBACK_PATH = "/clerk/callback";
const PENDING_KEY = "ayzen.clerk.pending";

export const publishableKeyEnvName = (module: string) => `VITE_CLERK_${module.toUpperCase()}_PUBLISHABLE_KEY`;

export function readPublishableKey(module: string, env: Record<string, unknown> | undefined = viteEnv()): string | null {
  const v = env?.[publishableKeyEnvName(module)];
  return typeof v === "string" && /^pk_(test|live)_[A-Za-z0-9+/=_-]{8,}$/.test(v) ? v : null;
}
function viteEnv(): Record<string, unknown> | undefined { try { return (import.meta as any).env; } catch { return undefined; } }

/** `pk_test_<base64(frontend-api-host + "$")>` -> the Frontend API host, or null when it does not look like one. */
export function frontendApiHost(publishableKey: string): string | null {
  const b64 = publishableKey.replace(/^pk_(test|live)_/, "").replace(/-/g, "+").replace(/_/g, "/");
  let decoded: string;
  try { decoded = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary"); } catch { return null; }
  if (!decoded.endsWith("$")) return null;
  const host = decoded.slice(0, -1);
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(host) ? host.toLowerCase() : null;
}

export const clerkScriptUrl = (host: string) => `https://${host}/npm/@clerk/clerk-js@5/dist/clerk.browser.js`;

let loading: Promise<any> | null = null;
export function loadClerk(publishableKey: string): Promise<any> {
  if (loading) return loading;
  const host = frontendApiHost(publishableKey);
  if (!host) return Promise.reject(new Error("CLERK_BAD_KEY"));
  loading = new Promise((resolve, reject) => {
    const w = window as any;
    const done = async () => { try { await w.Clerk.load(); resolve(w.Clerk); } catch (e) { loading = null; reject(e); } };
    if (w.Clerk) { void done(); return; }
    const s = document.createElement("script");
    s.async = true; s.crossOrigin = "anonymous"; s.src = clerkScriptUrl(host);
    s.setAttribute("data-clerk-publishable-key", publishableKey);
    s.onload = () => void done();
    s.onerror = () => { loading = null; reject(new Error("CLERK_SCRIPT_FAILED")); };
    document.head.appendChild(s);
  });
  return loading;
}

/** Remembers where to go afterwards (path only, never a URL) across the provider round trip. */
export function rememberClerkReturn(returnToPath: string, storage: Pick<Storage, "setItem"> | undefined = safeStorage()): void {
  try { storage?.setItem(PENDING_KEY, safePath(returnToPath)); } catch { /* storage may be unavailable */ }
}
export function takeClerkReturn(storage: Pick<Storage, "getItem" | "removeItem"> | undefined = safeStorage()): string {
  try { const v = storage?.getItem(PENDING_KEY); storage?.removeItem(PENDING_KEY); return safePath(v ?? "/"); } catch { return "/"; }
}
/** Same-origin absolute paths only: no scheme, no protocol-relative `//host`, no backslashes. */
export function safePath(p: string): string { return /^\/(?![/\\])[^\s\\]*$/.test(p) ? p : "/"; }
function safeStorage(): Storage | undefined { try { return window.sessionStorage; } catch { return undefined; } }

export async function startSocialLogin(module: string, provider: SocialProviderId, returnToPath = "/"): Promise<void> {
  const key = readPublishableKey(module);
  const p = SOCIAL_PROVIDERS.find((x) => x.id === provider);
  if (!key || !p) throw new Error("CLERK_NOT_CONFIGURED");
  const clerk = await loadClerk(key);
  rememberClerkReturn(returnToPath);
  await clerk.client.signIn.authenticateWithRedirect({
    strategy: p.strategy,
    redirectUrl: CLERK_CALLBACK_PATH,
    redirectUrlComplete: `${CLERK_CALLBACK_PATH}?done=1`,
    // A person new to Clerk becomes a sign-up automatically (the module account is created on first exchange).
    continueSignUp: false,
  });
}

/** On /clerk/callback: finish Clerk's redirect flow, return a session token for the module exchange. */
export async function finishSocialLogin(module: string, search: string): Promise<{ token: string; signOut: () => Promise<void> }> {
  const key = readPublishableKey(module);
  if (!key) throw new Error("CLERK_NOT_CONFIGURED");
  const clerk = await loadClerk(key);
  if (!new URLSearchParams(search).has("done")) {
    await clerk.handleRedirectCallback({ signInFallbackRedirectUrl: `${CLERK_CALLBACK_PATH}?done=1`, signUpFallbackRedirectUrl: `${CLERK_CALLBACK_PATH}?done=1` });
  }
  const token = await clerk.session?.getToken?.();
  if (typeof token !== "string" || !token) throw new Error("CLERK_NO_SESSION");
  return { token, signOut: async () => { try { await clerk.signOut(); } catch { /* best effort */ } } };
}
