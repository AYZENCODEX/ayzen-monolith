/**
 * scripts/src/oidc-seed-clients-data.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * W1-P3: the first-party OIDC client definitions, as pure data with NO database import, split out of
 * seed-oidc-clients.ts so they can be tested (and diffed against the module registry) in an environment
 * that has no DATABASE_URL / @workspace/db. seed-oidc-clients.ts re-exports everything here, so existing
 * importers (test-seed-oidc-clients.ts, test-oidc-phase2-exit.ts) are unaffected.
 *
 * Source of truth: packages/module-registry. Each module's client_id is its `oidcClientId` and every
 * redirect / post-logout / back-channel URL is built from its `defaultHost`, so adding or renaming a
 * module there cannot leave a stale or missing OIDC client behind (test-oidc-conformance.ts pins this).
 * `workspace` is the one client that is not a module: it is the central app itself.
 *
 * Every client here is public / PKCE-only: `clientSecretHash` is null, and /oidc/authorize rejects a
 * request without an S256 code_challenge for any client (lib/oidc-authorize-request.ts).
 */
import { MODULES } from "../../packages/module-registry/src/index.mjs";
import type { ModuleId } from "../../packages/module-registry/src/index.mjs";

export interface SeedClient {
  clientId: string;
  label: string; // display name only, never written to the DB
  clientSecretHash: null; // every seeded client here is public/PKCE-only
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  /** Season 3, Phase 6e-b: where this client receives OIDC Back-Channel Logout tokens. */
  backchannelLogoutUri: string | null;
  allowedScopes: string[];
  isFirstParty: true;
}

/** Season 1's registered scope set for every first-party AYZEN app (lib/oidc-scope-validation.ts KNOWN_OIDC_SCOPES). */
export const BASE_FIRST_PARTY_SCOPES = ["openid", "profile", "email"] as const;

/**
 * W1-P3: scopes are decided per client, not by one shared constant, so a module can be narrowed
 * (least privilege) with a one-line change here. Today every module needs the full base set — each one
 * shows the person's name/avatar and sends mail to the verified address — so the values are equal, but
 * the shape is per-module and a module missing from this map fails the conformance test.
 */
export const MODULE_CLIENT_SCOPES: Readonly<Record<ModuleId, readonly string[]>> = {
  sylo: BASE_FIRST_PARTY_SCOPES,
  ryft: BASE_FIRST_PARTY_SCOPES,
  fyra: BASE_FIRST_PARTY_SCOPES,
  verve: BASE_FIRST_PARTY_SCOPES,
  skarn: BASE_FIRST_PARTY_SCOPES,
  warde: BASE_FIRST_PARTY_SCOPES,
  wisp: BASE_FIRST_PARTY_SCOPES,
  zynth: BASE_FIRST_PARTY_SCOPES,
};

const origin = (host: string): string => `https://${host}`;

function moduleClient(m: (typeof MODULES)[number]): SeedClient {
  const o = origin(m.defaultHost);
  return {
    clientId: m.oidcClientId,
    label: m.label,
    clientSecretHash: null,
    redirectUris: [`${o}/oidc/callback`],
    postLogoutRedirectUris: [`${o}/`],
    backchannelLogoutUri: `${o}/oidc/backchannel-logout`,
    allowedScopes: [...(MODULE_CLIENT_SCOPES[m.id] ?? [])],
    isFirstParty: true,
  };
}

/** The main app: reachable at the bare domain and at workspace.ayzen.tech (a documented exception to `<id>.ayzen.tech`). */
const workspaceClient: SeedClient = {
  clientId: "workspace",
  label: "AYZEN Workspace",
  clientSecretHash: null,
  redirectUris: ["https://ayzen.tech/oidc/callback", "https://workspace.ayzen.tech/oidc/callback"],
  postLogoutRedirectUris: ["https://ayzen.tech/", "https://workspace.ayzen.tech/"],
  backchannelLogoutUri: "https://ayzen.tech/oidc/backchannel-logout",
  allowedScopes: [...BASE_FIRST_PARTY_SCOPES],
  isFirstParty: true,
};

/** Historic seed order (kept so dry-run output and diffs stay stable): the eight modules, then workspace. */
const SEED_ORDER = ["sylo", "ryft", "wisp", "verve", "zynth", "skarn", "fyra", "warde"] as const;

export const SEED_CLIENTS: SeedClient[] = [
  ...SEED_ORDER.map((id) => {
    const m = MODULES.find((x) => x.id === id);
    if (!m) throw new Error(`oidc-seed-clients-data: module '${id}' missing from @ayzen/module-registry`);
    return moduleClient(m);
  }),
  workspaceClient,
];
