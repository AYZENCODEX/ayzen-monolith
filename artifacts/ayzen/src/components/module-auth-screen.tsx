/**
 * components/module-auth-screen.tsx — W1-P4: the sign-in screen a module host shows once module sessions are on.
 *
 *   - the module's own credentials (email + password, W1-P2): sign in / create account;
 *   - "Continue with AYZEN" (flow 1: existing AYZEN user) and "Create an AYZEN account" (flow 2) when the module's OIDC rollout flag is on;
 *   - "I already have a <Module> account" (flow 3): sign in with AYZEN, then link that account (see pages/oidc-callback.tsx).
 *   - Google / Facebook / GitHub (W1-P5) through the module's own Clerk application when it is configured.
 */
import { useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ModuleAuthError, moduleLogin, moduleSignup, type ModuleAuthOptions } from "@/lib/module-auth-api";
import { startModuleOidcLogin, type ModuleOidcFlow } from "@/lib/module-oidc-login";
import { useAuth } from "@/hooks/use-auth";
import { SOCIAL_PROVIDERS, readPublishableKey, startSocialLogin, type SocialProviderId } from "@/lib/module-clerk";

const MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: "Wrong email or password.",
  IDENTIFIER_TAKEN: "An account with this email already exists here. Sign in instead.",
  PASSWORD_TOO_SHORT: "Use a longer password.",
  PASSWORD_TOO_SIMPLE: "Choose a less guessable password.",
  PASSWORD_EQUALS_IDENTIFIER: "The password cannot be your email.",
  INVALID_IDENTIFIER: "Enter a valid email address.",
  EMAIL_ACCOUNT_EXISTS: "This email already has a password account here. Sign in with your password.",
};

export function describeModuleAuthError(err: unknown): string {
  if (err instanceof ModuleAuthError) return MESSAGES[err.code] ?? err.solution ?? err.message;
  return "Something went wrong. Please try again.";
}

export function ModuleAuthScreen({ options, returnToPath = "/" }: { options: ModuleAuthOptions; returnToPath?: string }) {
  const [, setLocation] = useLocation();
  const { login: setAuthContext } = useAuth() as any;
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = mode === "signup" ? await moduleSignup(identifier.trim(), password) : await moduleLogin(identifier.trim(), password);
      setPassword("");
      setAuthContext(r.user, r.token, true);
      setLocation(returnToPath, { replace: true });
    } catch (err) {
      setError(describeModuleAuthError(err));
      setBusy(false);
    }
  };

  const viaAyzen = async (flow: ModuleOidcFlow) => {
    setError(null);
    try { await startModuleOidcLogin(options.module, { flow, returnToPath }); }
    catch { setError("Could not start AYZEN sign-in. Please try again."); }
  };

  const viaSocial = async (id: SocialProviderId) => {
    setError(null);
    try { await startSocialLogin(options.module, id, returnToPath); }
    catch { setError("Could not start social sign-in. Please try again."); }
  };
  const showSocial = options.social && readPublishableKey(options.module) !== null;

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="max-w-sm w-full space-y-6">
        <div className="text-center space-y-1">
          <h1 className="text-xl font-semibold">{options.label}</h1>
          <p className="text-sm text-muted-foreground">{mode === "signup" ? `Create your ${options.label} account` : `Sign in to ${options.label}`}</p>
        </div>

        {options.oidc && (
          <div className="space-y-2">
            <Button type="button" className="w-full" onClick={() => void viaAyzen("login")}>Continue with AYZEN</Button>
            <div className="flex justify-between text-xs">
              <button type="button" className="underline text-muted-foreground" onClick={() => void viaAyzen("signup")}>Create an AYZEN account</button>
              <button type="button" className="underline text-muted-foreground" onClick={() => void viaAyzen("link")}>I already have a {options.label} account</button>
            </div>
          </div>
        )}

        {showSocial && (
          <div className="space-y-2" aria-label="Social sign-in">
            {SOCIAL_PROVIDERS.map((p) => (
              <Button key={p.id} type="button" variant="outline" className="w-full" onClick={() => void viaSocial(p.id)}>Continue with {p.label}</Button>
            ))}
          </div>
        )}

        {options.password && (
          <form onSubmit={submit} className="space-y-4" aria-label={`${options.label} credentials`}>
            {(options.oidc || showSocial) && <div className="text-center text-xs text-muted-foreground">or use your {options.label} email and password</div>}
            <div className="space-y-2"><Label htmlFor="mod-id">Email</Label><Input id="mod-id" type="email" autoComplete="username" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required /></div>
            <div className="space-y-2"><Label htmlFor="mod-pw">Password</Label><Input id="mod-pw" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <Button type="submit" variant={options.oidc ? "outline" : "default"} className="w-full" disabled={busy}>
              {busy ? "Please wait..." : mode === "signup" ? "Create account" : "Sign in"}
            </Button>
            {options.signup && (
              <button type="button" className="w-full text-xs underline text-muted-foreground" onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setError(null); }}>
                {mode === "signup" ? "I already have an account" : `Create a ${options.label} account`}
              </button>
            )}
          </form>
        )}
        {!options.password && error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>
    </div>
  );
}
