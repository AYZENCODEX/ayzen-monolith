/**
 * pages/oidc-callback.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 3, Phase 5b-b: Callback Route.
 *
 * "Receive authorization response" — this is the page mounted at
 * `/oidc/callback`, the exact path `sylo-oidc-config.ts`'s
 * `SYLO_OIDC_CALLBACK_PATH` builds into the `redirect_uri` sent at 5b-a,
 * and the exact path `seed-oidc-clients.ts` registered
 * (`https://<client_id>.ayzen.tech/oidc/callback`). Deliberately a thin
 * wrapper: every actual decision (state verification, token exchange,
 * session establishment, error classification) lives in
 * `lib/sylo-oidc-callback.ts` (5b-c/5b-d/5b-e/5b-f) so it's unit-testable
 * without mounting this component — this file's only job is wiring that
 * logic to React lifecycle, `useAuth()`, and navigation.
 *
 * RUNS EXACTLY ONCE PER MOUNT
 * `completeSyloOidcLogin()` consumes the pending transaction and (via
 * `consumeAuthorizationCode()` on the provider side) the authorization
 * code itself — a second attempt with the same URL would fail anyway
 * (`invalid_grant`, the code was already redeemed), so the effect below
 * guards against React 18 Strict Mode's dev-only double-invoke with a
 * ref, not just an empty dependency array.
 *
 * 5b-f, CONCRETELY: three renderable states — `"working"` (spinner,
 * matches `ProtectedRoute`'s own "INITIALIZING..." full-screen style so
 * there's no visual seam between "redirecting for login" and "finishing
 * login"), `"error"` (message from `describeSyloOidcCallbackError()`, a
 * "Try again" button that restarts 5b-a, and a link back to the ordinary
 * `/login` form as a fallback that never depends on OIDC working), and
 * the success case, which never actually renders — it navigates away via
 * `setLocation()` before a frame would show anything.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { Loader2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { getSyloOidcClientConfig } from "@/lib/sylo-oidc-config";
import { getSyloOidcProviderMetadata } from "@/lib/sylo-oidc-discovery";
import { startSyloOidcLogin } from "@/lib/sylo-oidc-login";
import { exchangeCodeForTokens } from "@/lib/oidc-client";
import { exchangeSyloSessionCookie } from "@/lib/sylo-oidc-session-exchange";
import { ModuleAuthError, exchangeModuleOidcSession, getModuleAuthOptions } from "@/lib/module-auth-api";
import type { SessionExchangeResult } from "@/lib/sylo-oidc-callback";
import type { OidcTokenResponse } from "@/lib/oidc-client";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  parseSyloOidcCallbackParams,
  readPendingSyloOidcTransaction,
  clearPendingSyloOidcTransaction,
  completeSyloOidcLogin,
  describeSyloOidcCallbackError,
  reportSyloOidcCallbackError,
  SyloOidcCallbackError,
} from "@/lib/sylo-oidc-callback";

type CallbackState = { kind: "working" } | { kind: "link"; label: string } | { kind: "error"; title: string; description: string; canRetry: boolean };

export default function OidcCallback() {
  const [, setLocation] = useLocation();
  const { login: setAuthContext } = useAuth() as any;
  const [state, setState] = useState<CallbackState>({ kind: "working" });
  const ranRef = useRef(false);
  // W1-P4 flow 3 (link an existing module account): the OIDC code exchange has finished and its access token waits here, in
  // memory only, until the person has typed the module account's email + password.
  const linkRef = useRef<{ accessToken: string; resolve: (r: SessionExchangeResult) => void } | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkIdentifier, setLinkIdentifier] = useState("");
  const [linkPassword, setLinkPassword] = useState("");

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    (async () => {
      const params = parseSyloOidcCallbackParams(window.location.search);
      const pending = readPendingSyloOidcTransaction();

      try {
        const config = getSyloOidcClientConfig();
        const metadata = await getSyloOidcProviderMetadata();
        const moduleOpts = await getModuleAuthOptions();

        const result = await completeSyloOidcLogin(params, pending, {
          config,
          metadata,
          exchangeCode: exchangeCodeForTokens,
          // W1-P4: on a module host with module sessions on, the OIDC access token (not a shared cookie) opens the module
          // session; otherwise the legacy shared-cookie exchange runs exactly as before.
          sessionExchange: moduleOpts?.oidc
            ? (tokens: OidcTokenResponse) =>
                pending?.flow === "link"
                  ? new Promise<SessionExchangeResult>((resolve) => {
                      linkRef.current = { accessToken: tokens.access_token, resolve };
                      setState({ kind: "link", label: moduleOpts.label });
                    })
                  : exchangeModuleOidcSession(tokens.access_token)
            : exchangeSyloSessionCookie,
        });

        // Sylo's own session model (Phase 5b-e) — same call shape every
        // other login path in this codebase already ends with
        // (login.tsx's backendLogin/handleMagicVerify/passkey sign-in).
        // `keepSignedIn` defaults true here: an OIDC round-trip only ever
        // completes when the shared central cookie was already valid, so
        // there is no separate "remember me" choice being made at this
        // step the way the credential-form login page has to ask for.
        setAuthContext(result.user, result.token, true);

        setLocation(result.returnToPath || "/", { replace: true });
      } catch (err) {
        clearPendingSyloOidcTransaction();
        // Season 3, Phase 5e-b (additive) — best-effort, never blocks
        // rendering the error state below. See
        // reportSyloOidcCallbackError()'s own header for why
        // "provider_error" is deliberately excluded.
        if (err instanceof SyloOidcCallbackError) reportSyloOidcCallbackError(err.code);
        const described = describeSyloOidcCallbackError(err);
        setState({ kind: "error", ...described });
      }
    })();
  }, []);

  if (state.kind === "link") {
    const submit = async (e: FormEvent) => {
      e.preventDefault();
      if (!linkRef.current || linkBusy) return;
      setLinkBusy(true);
      setLinkError(null);
      try {
        // `.resolve` completes completeSyloOidcLogin(), which then signs in and navigates.
        const r = await exchangeModuleOidcSession(linkRef.current.accessToken, { identifier: linkIdentifier.trim(), password: linkPassword });
        setLinkPassword("");
        linkRef.current.resolve(r);
      } catch (err) {
        setLinkError(err instanceof ModuleAuthError ? (err.solution ?? err.message) : "Could not link the account. Try again.");
        setLinkBusy(false);
      }
    };
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <form onSubmit={submit} className="max-w-sm w-full space-y-4">
          <h1 className="text-lg font-semibold">Link your {state.label} account</h1>
          <p className="text-sm text-muted-foreground">
            You signed in with AYZEN. Enter the email and password of the {state.label} account you already use so both sign-ins open the same account.
          </p>
          <div className="space-y-2"><Label htmlFor="link-id">Email</Label><Input id="link-id" type="email" autoComplete="username" value={linkIdentifier} onChange={(e) => setLinkIdentifier(e.target.value)} required /></div>
          <div className="space-y-2"><Label htmlFor="link-pw">Password</Label><Input id="link-pw" type="password" autoComplete="current-password" value={linkPassword} onChange={(e) => setLinkPassword(e.target.value)} required /></div>
          {linkError && <p role="alert" className="text-sm text-destructive">{linkError}</p>}
          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={linkBusy}>{linkBusy ? "Linking..." : "Link account"}</Button>
            <Button type="button" variant="outline" onClick={() => setLocation("/login")}>Cancel</Button>
          </div>
        </form>
      </div>
    );
  }

  if (state.kind === "working") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-primary font-mono gap-3">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>FINISHING SIGN-IN...</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="max-w-sm w-full text-center space-y-4">
        <AlertTriangle className="h-8 w-8 text-destructive mx-auto" />
        <h1 className="text-lg font-semibold">{state.title}</h1>
        <p className="text-sm text-muted-foreground">{state.description}</p>
        <div className="flex flex-col gap-2 pt-2">
          {state.canRetry && (
            <Button onClick={() => { void startSyloOidcLogin("/"); }}>
              Try again
            </Button>
          )}
          <Button variant="outline" onClick={() => setLocation("/login")}>
            Use the sign-in form instead
          </Button>
        </div>
      </div>
    </div>
  );
}
