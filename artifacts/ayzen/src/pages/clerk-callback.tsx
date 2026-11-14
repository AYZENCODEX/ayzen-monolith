/**
 * pages/clerk-callback.tsx — W1-P5. Landing page after Google / Facebook / GitHub through this module's own Clerk application.
 * Finishes Clerk's redirect flow, trades the Clerk session token for a module session (POST /api/auth/module/clerk), then
 * signs out of Clerk so the module session is the only one kept. Runs once per mount (Strict Mode safe).
 */
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Loader2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { ModuleAuthError, exchangeModuleClerkSession, getModuleAuthOptions } from "@/lib/module-auth-api";
import { finishSocialLogin, takeClerkReturn } from "@/lib/module-clerk";

export default function ClerkCallback() {
  const [, setLocation] = useLocation();
  const { login: setAuthContext } = useAuth() as any;
  const ran = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    (async () => {
      try {
        const options = await getModuleAuthOptions();
        if (!options?.social) throw new ModuleAuthError("CLERK_NOT_ENABLED", "Social sign-in is not available here.");
        const { token, signOut } = await finishSocialLogin(options.module, window.location.search);
        const r = await exchangeModuleClerkSession(token);
        await signOut();
        setAuthContext(r.user, r.token, true);
        setLocation(takeClerkReturn(), { replace: true });
      } catch (err) {
        setError(err instanceof ModuleAuthError && err.code === "EMAIL_ACCOUNT_EXISTS"
          ? "This email already has a password account here. Sign in with your password."
          : "Social sign-in could not be completed. Please try again or use your email and password.");
      }
    })();
  }, [setAuthContext, setLocation]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="max-w-sm w-full space-y-4 text-center">
          <AlertTriangle className="mx-auto h-8 w-8 text-destructive" aria-hidden />
          <p role="alert" className="text-sm">{error}</p>
          <Button type="button" onClick={() => setLocation("/login", { replace: true })}>Back to sign in</Button>
        </div>
      </div>
    );
  }
  return (
    <div className="min-h-screen flex items-center justify-center bg-background" role="status" aria-live="polite">
      <Loader2 className="h-6 w-6 animate-spin" aria-label="Completing sign-in" />
    </div>
  );
}
