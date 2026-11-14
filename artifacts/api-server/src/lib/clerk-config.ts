/**
 * lib/clerk-config.ts — W1-P5: per-module Clerk configuration (ADR A3: ONE Clerk application per module; user pools are separate).
 *
 * Environment, per module id in upper case (SYLO, RYFT, FYRA, VERVE, SKARN, WARDE, WISP, ZYNTH):
 *   CLERK_<M>_ISSUER              the Clerk Frontend API origin of that module's application, e.g. https://clerk.sylo.ayzen.tech
 *   CLERK_<M>_JWKS_URL            optional override; default <issuer>/.well-known/jwks.json
 *   CLERK_<M>_WEBHOOK_SECRET      the application's Svix signing secret (whsec_...)
 *   CLERK_<M>_AUTHORIZED_PARTIES  optional extra comma-separated origins allowed as the token's `azp` (module hosts are always allowed)
 * and the global switch MODULE_CLERK_ENABLED=1. A module without an issuer simply has no social login: nothing else changes.
 *
 * Isolation rule (roadmap "critical rule"): no cross-module Clerk SSO. Enforced here by `clerkTopologyProblems` (two modules may not
 * share an issuer or a webhook secret) and in lib/clerk-verify.ts (a token is only ever checked against the issuer/keys of the
 * module the request is for). AYZEN's own accounts are NOT stored in Clerk: AYZEN OIDC stays the single shared identity provider
 * (docs/identity-boundaries.md).
 */
import { MODULES, getModule, type ModuleId } from "@ayzen/module-registry";

export interface ClerkModuleConfig {
  module: ModuleId;
  issuer: string;
  jwksUrl: string;
  webhookSecret: string | null;
  authorizedParties: string[];
}

const upper = (m: string) => m.toUpperCase();
export const clerkEnvName = (module: string, key: "ISSUER" | "JWKS_URL" | "WEBHOOK_SECRET" | "AUTHORIZED_PARTIES") => `CLERK_${upper(module)}_${key}`;
/** The browser-side env var (Vite) holding the module's Clerk publishable key. */
export const clerkPublishableKeyEnvName = (module: string) => `VITE_CLERK_${upper(module)}_PUBLISHABLE_KEY`;

export const isClerkFeatureEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.MODULE_CLERK_ENABLED === "1";

/** https origin only (no path/query), no trailing slash; null when unusable. */
export function normalizeIssuer(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return null;
    return u.origin;
  } catch { return null; }
}

function originsFrom(list: string | undefined): string[] {
  return (list ?? "").split(",").map((s) => normalizeIssuer(s) ?? "").filter(Boolean);
}

export function readClerkConfig(module: string, env: NodeJS.ProcessEnv = process.env): ClerkModuleConfig | null {
  if (!isClerkFeatureEnabled(env)) return null;
  const def = getModule(module);
  if (!def) return null;
  const issuer = normalizeIssuer(env[clerkEnvName(def.id, "ISSUER")]);
  if (!issuer) return null;
  const hosts = (env[def.hostEnv] ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  const moduleOrigins = [...new Set([def.defaultHost, ...hosts])].map((h) => `https://${h}`);
  const jwks = normalizeIssuer(env[clerkEnvName(def.id, "JWKS_URL")]?.replace(/\/\.well-known\/jwks\.json$/, "")) ;
  return {
    module: def.id,
    issuer,
    jwksUrl: jwks ? `${jwks}/.well-known/jwks.json` : `${issuer}/.well-known/jwks.json`,
    webhookSecret: env[clerkEnvName(def.id, "WEBHOOK_SECRET")]?.trim() || null,
    authorizedParties: [...new Set([...moduleOrigins, ...originsFrom(env[clerkEnvName(def.id, "AUTHORIZED_PARTIES")])])],
  };
}

/** Social sign-in is offered for a module only when the feature is on and its own Clerk application is configured. */
export const isClerkConfigured = (module: string, env: NodeJS.ProcessEnv = process.env): boolean => readClerkConfig(module, env) !== null;

/** Problems that would break per-module isolation: a shared issuer or a shared webhook secret between two modules. Empty = fine. */
export function clerkTopologyProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const seenIssuer = new Map<string, string>();
  const seenSecret = new Map<string, string>();
  for (const m of MODULES) {
    const raw = env[clerkEnvName(m.id, "ISSUER")];
    if (raw && !normalizeIssuer(raw)) out.push(`${clerkEnvName(m.id, "ISSUER")} must be an https origin`);
    const cfg = readClerkConfig(m.id, { ...env, MODULE_CLERK_ENABLED: "1" });
    if (!cfg) continue;
    const prev = seenIssuer.get(cfg.issuer);
    if (prev) out.push(`modules ${prev} and ${m.id} share the Clerk issuer ${cfg.issuer} (one Clerk application per module)`);
    seenIssuer.set(cfg.issuer, m.id);
    if (cfg.webhookSecret) {
      const p2 = seenSecret.get(cfg.webhookSecret);
      if (p2) out.push(`modules ${p2} and ${m.id} share a Clerk webhook secret`);
      seenSecret.set(cfg.webhookSecret, m.id);
    }
  }
  return out;
}
