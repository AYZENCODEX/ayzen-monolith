/**
 * lib/module-oidc-login.ts — W1-P4: "Login with AYZEN" on every module.
 *
 * `startModuleOidcLogin(moduleId, { flow })` generalises startSyloOidcLogin: same Authorization Code + PKCE round trip against
 * the module's own OIDC client (resolved from the host, lib/sylo-oidc-config.ts), now with an explicit flow:
 *   login  - an existing AYZEN user signs in (and gets a module account on first use);
 *   signup - the visitor has no AYZEN account: the central signup page opens first (`screen_hint=signup`), then the same round trip;
 *   link   - after the round trip the callback asks for an existing module account's email+password and attaches the identity.
 * The tokens never leave memory; the pending transaction (state, PKCE verifier, nonce, flow) is the same single-use
 * sessionStorage record the legacy flow uses, so lib/sylo-oidc-callback.ts verifies it unchanged.
 */
import { getModule } from "@ayzen/module-registry";
import { buildAuthorizeUrl, generatePkcePair, generateState } from "./oidc-client";
import { getSyloOidcClientConfig } from "./sylo-oidc-config";
import { getSyloOidcProviderMetadata } from "./sylo-oidc-discovery";
import { SYLO_OIDC_PENDING_KEY, type PendingSyloOidcTransaction } from "./sylo-oidc-login";
import { getCurrentSubdomainApp } from "./subdomain-app";

export type ModuleOidcFlow = "login" | "signup" | "link";

/** Pure: the authorize URL for a flow. Only `signup` adds a parameter. */
export function withFlowHint(authorizeUrl: string, flow: ModuleOidcFlow): string {
  if (flow !== "signup") return authorizeUrl;
  const u = new URL(authorizeUrl);
  u.searchParams.set("screen_hint", "signup");
  return u.toString();
}

export async function startModuleOidcLogin(moduleId: string, opts: { flow?: ModuleOidcFlow; returnToPath?: string } = {}): Promise<void> {
  if (typeof window === "undefined") throw new Error("startModuleOidcLogin() requires a browser environment");
  const def = getModule(moduleId);
  if (!def) throw new Error(`Unknown module '${moduleId}'`);
  // A module's sign-in can only be started from that module's own host: the client id (and redirect_uri) come from the host.
  if (getCurrentSubdomainApp()?.id !== def.id) throw new Error(`startModuleOidcLogin('${moduleId}') must run on ${def.defaultHost}`);

  const flow = opts.flow ?? "login";
  const config = getSyloOidcClientConfig();
  if (config.clientId !== def.oidcClientId) throw new Error(`OIDC client mismatch for ${moduleId}: ${config.clientId}`);
  const metadata = await getSyloOidcProviderMetadata();
  const { codeVerifier, codeChallenge } = await generatePkcePair();
  const state = generateState();
  const nonce = generateState();

  const pending: PendingSyloOidcTransaction = {
    state, codeVerifier, nonce,
    clientId: config.clientId,
    returnToPath: opts.returnToPath ?? def.homePath,
    createdAt: Date.now(),
    flow,
  };
  window.sessionStorage.setItem(SYLO_OIDC_PENDING_KEY, JSON.stringify(pending));
  window.location.assign(withFlowHint(buildAuthorizeUrl(config, metadata, codeChallenge, state, nonce), flow));
}
