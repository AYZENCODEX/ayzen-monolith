import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { AuthBackdrop, type BackdropNode } from "@/components/auth/auth-backdrop";
import { Btn, CodeField, Divider, Field, Heading, Notice } from "@/components/auth/portal";
import { Terminal, ArrowRight, Mail, Eye, EyeOff, Check, RefreshCw, Fingerprint, X as XIcon, UserRound } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { SuccessAnimation } from "@/components/success-animation";
import { loginWithPasskey, browserSupportsWebAuthn } from "@/lib/passkey-api";
// OIDC Roadmap — Season 3, Phase 5d-c: cutover-redirect effect (see below,
// near oidcReturnTo).
import { getCurrentSubdomainApp } from "@/lib/subdomain-app";
import { getRoleHostRedirect } from "@/lib/role-hosts";
import { getSyloOidcRolloutFlag } from "@/lib/sylo-oidc-rollout-flag";
import { startSyloOidcLogin } from "@/lib/sylo-oidc-login";

import { getApiBase } from "@/lib/api-base";
import { useModuleAwareNavigate } from "@/components/module-link";
const BASE = getApiBase();


async function backendLogin(email: string, password: string): Promise<any | null> {
  try {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function backendRegister(username: string, email: string, password: string, emailOtp: string, refCode?: string): Promise<{ token: string; user: any; error?: string } | null> {
  try {
    const res = await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, email, password, emailOtp, ...(refCode ? { refCode } : {}) }),
    });
    const data = await res.json();
    if (!res.ok) return { token: "", user: null, error: data.error ?? "Registration failed" };
    return data;
  } catch {
    return null;
  }
}

// Module colours follow the Zynth palette. Module-level so the canvas effect
// does not restart on every render.
const PORTAL_NODES: BackdropNode[] = [
  { key: "sylo", color: "#5FE3D6" },
  { key: "skarn", color: "#8F7CFF" },
  { key: "warde", color: "#7CC4FF" },
  { key: "wisp", color: "#FF6FB5" },
  { key: "ryft", color: "#FFB86B" },
  { key: "fyra", color: "#9BE37C" },
  { key: "verve", color: "#C58CFF" },
  { key: "zynth", color: "#EAF2FF" },
];

function makeCaptcha() {
  const a = Math.floor(Math.random() * 9) + 1;
  const b = Math.floor(Math.random() * 9) + 1;
  const ops = [
    { q: `${a} + ${b}`, ans: a + b },
    { q: `${a + b} − ${b}`, ans: a },
    { q: `${a} × ${b > 5 ? 2 : b}`, ans: a * (b > 5 ? 2 : b) },
  ];
  return ops[Math.floor(Math.random() * ops.length)];
}

export default function Login() {
  const setLocation = useModuleAwareNavigate();
  const { login: setAuthContext, accounts, switchAccount, removeAccount, user: authedUser } = useAuth() as any;
  const { toast } = useToast();

  // OIDC Roadmap — Season 2, Phase 3b-b/3b-c: central-login redirect target.
  // `routes/oidc-authorize.ts` sends an unauthenticated user here with
  // `?return_to=/oidc/authorize?...` (that route's own `req.originalUrl` —
  // server-constructed, never a client-supplied value) when 3b-a finds no
  // existing session. Read once on mount; only ever a same-origin
  // `/oidc/authorize` path is honored (belt-and-suspenders — the actual
  // trust boundary is that this value was never accepted from anywhere
  // except that one server redirect in the first place, same as any other
  // `return_to`/`next` pattern that must not become an open redirect).
  //
  // UPDATE — Season 4, Phase 7b: `/oidc/consent` (the consent screen,
  // `pages/oidc-consent.tsx`) added to this same allow-list, for the
  // identical reason. That page does its own "am I signed in" check
  // (`useAuth()`) on mount and, when there's no session, bounces here the
  // same way — `?return_to=/oidc/consent?...` — with the exact same
  // trust boundary: server-constructed by that page from
  // `window.location.pathname + search`, never accepted from any other
  // source. Both prefixes share this one allow-list rather than each
  // page inventing its own, so there's exactly one place that decides
  // what `return_to` is allowed to point at.
  const OIDC_RETURN_TO_PREFIXES = ["/oidc/authorize", "/oidc/consent"];
  const [oidcReturnTo] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const value = new URLSearchParams(window.location.search).get("return_to");
    return value && OIDC_RETURN_TO_PREFIXES.some((prefix) => value.startsWith(prefix)) ? value : null;
  });

  // OIDC Roadmap — Season 3, Phase 5d-c: cutover-redirect effect.
  //
  // App.tsx's ProtectedRoute (5c-c) only starts the OIDC redirect for
  // routes IT guards — but `/login` itself is mounted OUTSIDE
  // ProtectedRoute (same tier as the OIDC callback route, see App.tsx's
  // own router), precisely so it keeps working as the credential-entry
  // fallback while the flag is off (5c-b). That means a direct hit on
  // `sylo.ayzen.tech/login` — a bookmark, a stale link, someone typing the
  // URL — was always a loophole around 5c-c's gate: once the rollout flag
  // is ON for an app, this page should not just remain reachable as a
  // second, parallel way to authenticate into it. This effect closes that
  // loophole the same way ProtectedRoute closes it for every OTHER route:
  // ask the identical rollout flag, and if it's on, hand off to
  // `startSyloOidcLogin()` instead of ever rendering the form below.
  //
  // Conditions, all required:
  //   - `subdomainApp` resolved (never runs on the main domain — ayzen.tech
  //     keeps `/login` as its only login mechanism, unchanged).
  //   - No `oidcReturnTo` — a request already carrying `?return_to=` came
  //     FROM `/oidc/authorize` itself (3b-a's own redirect for "no
  //     session"), so redirecting it right back into `startSyloOidcLogin()`
  //     would just loop; this page's job for that visitor is showing the
  //     credential form so `redirectAfterLogin()` above can resume the
  //     transaction on success.
  //   - Not already authenticated — `useAuth()`'s `user` below covers a
  //     signed-in visitor who navigated to `/login` directly; nothing to
  //     redirect through OIDC for someone who already has a session.
  //
  // Same `null` = "still checking" discipline ProtectedRoute's own
  // `oidcRolloutEnabled` state uses, and the identical loader is shown
  // while unresolved so this page never flashes the credential form for a
  // visitor who's about to be redirected away from it.
  const [cutoverRedirectState, setCutoverRedirectState] = useState<"checking" | "redirecting" | "done">(() => {
    if (typeof window === "undefined") return "done";
    return getCurrentSubdomainApp() && !oidcReturnTo ? "checking" : "done";
  });
  useEffect(() => {
    if (cutoverRedirectState !== "checking") return;
    if (authedUser) { setCutoverRedirectState("done"); return; }
    const subdomainApp = getCurrentSubdomainApp();
    if (!subdomainApp) { setCutoverRedirectState("done"); return; }
    let cancelled = false;
    void getSyloOidcRolloutFlag(subdomainApp.id).then((enabled) => {
      if (cancelled) return;
      if (enabled) {
        setCutoverRedirectState("redirecting");
        void startSyloOidcLogin();
      } else {
        setCutoverRedirectState("done");
      }
    });
    return () => { cancelled = true; };
  }, [cutoverRedirectState, authedUser]);

  // 3b-c, applied: every existing post-login navigation in this file
  // ("go to /dashboard or /admin/dashboard") now funnels through here so
  // an in-flight `/oidc/authorize` transaction is resumed instead of
  // dropped. A full navigation (`window.location.href`), not `setLocation`
  // — `return_to` targets a server route (`/oidc/authorize`), not an SPA
  // route wouter knows how to render, and the whole point of resuming it
  // is a fresh request that now carries the just-set `ayzen_session`
  // cookie so 3b-a's session check succeeds this time.
  function redirectAfterLogin(role: string) {
    if (oidcReturnTo) {
      window.location.href = oidcReturnTo;
      return;
    }
    // Phase 7: with role hosts on, an admin/moderator/team leader signing in
    // on the wrong host lands on their own (full navigation: new origin).
    const roleUrl = getRoleHostRedirect(role, role === "admin" ? "/admin/dashboard" : "/dashboard");
    if (roleUrl) {
      window.location.href = roleUrl;
      return;
    }
    if (role === "admin") setLocation("/admin/dashboard");
    else setLocation("/dashboard");
  }

  const [tab, setTab] = useState<"signin" | "signup" | "magic">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [refCode, setRefCode] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [magicSent, setMagicSent] = useState(false);
  const [magicLoading, setMagicLoading] = useState(false);
  const [magicCode, setMagicCode] = useState("");
  const [magicVerifyLoading, setMagicVerifyLoading] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [successMsg, setSuccessMsg] = useState("");

  const [captcha, setCaptcha] = useState(makeCaptcha);
  const [captchaInput, setCaptchaInput] = useState("");
  const [captchaError, setCaptchaError] = useState(false);

  // Google-style "choose an account" screen — only relevant when this
  // browser already has other AYZEN accounts saved (see hooks/use-auth.tsx).
  // Defaults to showing the picker when there's something to pick from;
  // "Use another account" drops straight to the normal sign-in form below.
  const [showChooser, setShowChooser] = useState(true);

  // signup OTP flow
  const [signupStep, setSignupStep] = useState<"form" | "otp">("form");
  const [signupOtp, setSignupOtp] = useState("");
  const [signupSendingOtp, setSignupSendingOtp] = useState(false);
  const [signupCountdown, setSignupCountdown] = useState(0);

  // signin OTP flow (2-step: credentials → email OTP)
  const [signinStep, setSigninStep] = useState<"form" | "otp" | "stepup">("form");
  const [signinOtp, setSigninOtp] = useState("");
  const [signinCountdown, setSigninCountdown] = useState(0);
  const [tempSigninData, setTempSigninData] = useState<{ token: string; user: any } | null>(null);
  const [signinOtpSending, setSigninOtpSending] = useState(false);
  const [signinOtpLoading, setSigninOtpLoading] = useState(false);
  const [keepSignedIn, setKeepSignedIn] = useState(false);

  // Anomalous-IP step-up chain (see lib/login-security.ts on the server):
  // every configured factor listed in requiredMethods must be individually
  // verified — tracked here in completedMethods — before a session opens.
  const [stepUp, setStepUp] = useState<{ challengeToken: string; requiredMethods: string[]; completedMethods: string[] } | null>(null);
  const [stepUpEmailCode, setStepUpEmailCode] = useState("");
  const [stepUpTotpCode, setStepUpTotpCode] = useState("");
  const [stepUpBackupCode, setStepUpBackupCode] = useState("");
  const [stepUpBusy, setStepUpBusy] = useState<string | null>(null);

  useEffect(() => {
    if (signupCountdown <= 0) return;
    const t = setTimeout(() => setSignupCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [signupCountdown]);

  useEffect(() => {
    if (signinCountdown <= 0) return;
    const t = setTimeout(() => setSigninCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [signinCountdown]);

  const handleSendSignupOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !email || !password) {
      toast({ variant: "destructive", title: "Fill all fields", description: "Username, email and password are required." });
      return;
    }
    if (password.length < 6) {
      toast({ variant: "destructive", title: "Password too short", description: "Minimum 6 characters." });
      return;
    }
    if (parseInt(captchaInput) !== captcha.ans) {
      setCaptchaError(true);
      setCaptcha(makeCaptcha());
      setCaptchaInput("");
      toast({ variant: "destructive", title: "Captcha failed" });
      return;
    }
    setCaptchaError(false);
    setSignupSendingOtp(true);
    try {
      const res = await fetch(`${BASE}/api/auth/send-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (res.ok) {
        toast({ title: "Code sent!", description: `6-digit code sent to ${email}` });
        setSignupStep("otp");
        setSignupCountdown(60);
      } else {
        toast({ variant: "destructive", title: "Failed to send code", description: data.error ?? "Try again." });
      }
    } catch {
      toast({ variant: "destructive", title: "Connection error" });
    }
    setSignupSendingOtp(false);
  };

  const handleResendSignupOtp = async () => {
    if (signupCountdown > 0) return;
    setSignupSendingOtp(true);
    try {
      const res = await fetch(`${BASE}/api/auth/send-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (res.ok) {
        toast({ title: "Code resent!" });
        setSignupCountdown(60);
      }
    } catch {}
    setSignupSendingOtp(false);
  };


  const handleMagicVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!magicCode.trim()) return;
    setMagicVerifyLoading(true);
    try {
      const res = await fetch(`${BASE}/api/auth/magic-link/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code: magicCode.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.token) {
        setAuthContext(data.user, data.token);
        setSuccessMsg(`Access granted, ${data.user.username}!`);
        setShowSuccess(true);
        setTimeout(() => redirectAfterLogin(data.user.role), 1600);
      } else {
        toast({ variant: "destructive", title: data.error ?? "Invalid code" });
      }
    } catch {
      toast({ variant: "destructive", title: "Connection error" });
    }
    setMagicVerifyLoading(false);
  };

  const DEMO_EMAILS = ["demoadmin@ayzen.io", "demo@ayzen.io"];

  const [passkeyLoading, setPasskeyLoading] = useState(false);

  const handlePasskeySignIn = async () => {
    setPasskeyLoading(true);
    try {
      const data = await loginWithPasskey(email.trim() || undefined);
      if (data.requiresStepUp) {
        setStepUp({ challengeToken: data.challengeToken!, requiredMethods: data.requiredMethods ?? [], completedMethods: data.completedMethods ?? [] });
        setSigninStep("stepup");
        toast({ title: "New sign-in location detected", description: "Passkey confirmed — finish the remaining steps below to continue." });
        setPasskeyLoading(false);
        return;
      }
      setAuthContext(data.user, data.token!, keepSignedIn);
      setSuccessMsg(`Welcome back, ${data.user.username}!`);
      setShowSuccess(true);
      setTimeout(() => redirectAfterLogin(data.user.role), 1600);
    } catch (err: any) {
      if (err?.name !== "NotAllowedError") {
        toast({ variant: "destructive", title: "Passkey sign-in failed", description: err?.message ?? "Try again." });
      }
    }
    setPasskeyLoading(false);
  };

  // "Login with AYZEN" — the main domain's own first-party OIDC login
  // button (see `WORKSPACE_OIDC_CLIENT_ID`, sylo-oidc-config.ts). Reuses
  // Season 3's generic `startSyloOidcLogin()` as-is: on the main domain
  // `resolveSyloOidcClientId()` now resolves to `"workspace"`, so the same
  // Authorization Code + PKCE round-trip Sylo/Ryft/etc. use for their
  // auto-cutover works here too — just started by an explicit button click
  // instead of an automatic redirect, and only ever offered as one option
  // alongside the existing credential form, never replacing it.
  // `"/dashboard"` is passed explicitly (matching every other sign-in
  // path's own post-login destination below) rather than defaulting to the
  // current path, since a click starting from `/login` itself has no
  // more-specific "where was the user headed" to preserve.
  const [workspaceOidcLoading, setWorkspaceOidcLoading] = useState(false);
  const handleWorkspaceOidcSignIn = async () => {
    setWorkspaceOidcLoading(true);
    try {
      await startSyloOidcLogin("/dashboard");
      // Never resolves on success — the tab navigates away.
    } catch (err: any) {
      toast({ variant: "destructive", title: "Sign-in with AYZEN failed", description: err?.message ?? "Try again." });
      setWorkspaceOidcLoading(false);
    }
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    setLoading(true);
    try {
      const data = await backendLogin(email, password);
      if (data) {
        // Anomalous-IP login pattern: password checked out, but this IP
        // hasn't succeeded on this account before — every configured
        // factor must clear before a session opens.
        if (data.requiresStepUp) {
          setStepUp({ challengeToken: data.challengeToken, requiredMethods: data.requiredMethods, completedMethods: data.completedMethods });
          setSigninStep("stepup");
          toast({ title: "New sign-in location detected", description: "We've sent a confirmation code to your email — please clear every step below to continue." });
          setLoading(false);
          return;
        }
        // Demo accounts: skip OTP entirely
        if (DEMO_EMAILS.includes(email.toLowerCase().trim())) {
          setAuthContext(data.user, data.token, keepSignedIn);
          setSuccessMsg(`Welcome back, ${data.user.username}!`);
          setShowSuccess(true);
          setTimeout(() => redirectAfterLogin(data.user.role), 1600);
          setLoading(false);
          return;
        }
        // Step 1: credentials valid — send OTP
        setTempSigninData(data);
        setSigninOtpSending(true);
        try {
          const otpRes = await fetch(`${BASE}/api/auth/send-otp`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email }),
          });
          const otpData = await otpRes.json();
          if (otpRes.ok) {
            toast({ title: "Code sent!", description: `Verification code sent to ${email}` });
            setSigninStep("otp");
            setSigninCountdown(60);
          } else {
            toast({ variant: "destructive", title: "Failed to send code", description: otpData.error ?? "Try again." });
          }
        } catch {
          toast({ variant: "destructive", title: "Connection error sending OTP" });
        }
        setSigninOtpSending(false);
      } else {
        toast({ variant: "destructive", title: "Access denied", description: "Invalid credentials. Check email and password." });
      }
    } catch {
      toast({ variant: "destructive", title: "Connection error", description: "Could not reach server. Try again." });
    }
    setLoading(false);
  };

  const handleSigninOtpVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signinOtp.trim() || signinOtp.length !== 6 || !tempSigninData) return;
    setSigninOtpLoading(true);
    try {
      const res = await fetch(`${BASE}/api/auth/verify-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code: signinOtp.trim() }),
      });
      const result = await res.json();
      if (res.ok && result.valid) {
        setAuthContext(tempSigninData.user, tempSigninData.token, keepSignedIn);
        setSuccessMsg(`Welcome back, ${tempSigninData.user.username}!`);
        setShowSuccess(true);
        setTimeout(() => {
          redirectAfterLogin(tempSigninData.user.role);
        }, 1600);
      } else {
        toast({ variant: "destructive", title: result.error ?? "Invalid code" });
        setSigninOtp("");
      }
    } catch {
      toast({ variant: "destructive", title: "Connection error" });
    }
    setSigninOtpLoading(false);
  };

  const handleResendSigninOtp = async () => {
    if (signinCountdown > 0) return;
    setSigninOtpSending(true);
    try {
      const res = await fetch(`${BASE}/api/auth/send-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (res.ok) { toast({ title: "Code resent!" }); setSigninCountdown(60); }
    } catch {}
    setSigninOtpSending(false);
  };

  // ─── Anomalous-IP step-up chain ───────────────────────────────────────────
  // Fires when POST /auth/login (or a fresh passkey login) comes back with
  // requiresStepUp — every factor in stepUp.requiredMethods must clear
  // individually before a session opens. See lib/login-security.ts on the
  // server for the full design note.
  const grantStepUpSession = (data: any) => {
    setAuthContext(data.user, data.token, keepSignedIn);
    setSuccessMsg(`Welcome back, ${data.user.username}!`);
    setShowSuccess(true);
    setStepUp(null);
    setTimeout(() => {
      redirectAfterLogin(data.user.role);
    }, 1600);
  };

  const submitStepUpMethod = async (method: "email_otp" | "totp" | "backup_code", code: string) => {
    if (!stepUp || !code.trim()) return;
    setStepUpBusy(method);
    try {
      const res = await fetch(`${BASE}/api/auth/login/step-up/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeToken: stepUp.challengeToken, method, code: code.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 429) {
          toast({ variant: "destructive", title: "Sign-in confirmation locked", description: data.error ?? "Too many failed attempts. Please log in again." });
          setStepUp(null);
          setSigninStep("form");
          setStepUpEmailCode(""); setStepUpTotpCode(""); setStepUpBackupCode("");
          return;
        }
        toast({ variant: "destructive", title: data.error ?? "Verification failed" });
        return;
      }
      if (data.verified) {
        grantStepUpSession(data);
      } else {
        setStepUp(prev => prev ? { ...prev, completedMethods: data.completedMethods } : prev);
        toast({ title: "Verified", description: "Continue with the remaining steps below." });
        if (method === "email_otp") setStepUpEmailCode("");
        if (method === "totp") setStepUpTotpCode("");
        if (method === "backup_code") setStepUpBackupCode("");
      }
    } catch {
      toast({ variant: "destructive", title: "Connection error" });
    } finally {
      setStepUpBusy(null);
    }
  };

  const submitStepUpPasskey = async () => {
    if (!stepUp) return;
    setStepUpBusy("passkey");
    try {
      const data = await loginWithPasskey(email.trim() || undefined, stepUp.challengeToken);
      if (data.verified) {
        grantStepUpSession(data);
      } else {
        setStepUp(prev => prev ? { ...prev, completedMethods: data.completedMethods ?? prev.completedMethods } : prev);
        toast({ title: "Passkey verified", description: "Continue with the remaining steps below." });
      }
    } catch (err: any) {
      if (err?.name !== "NotAllowedError") {
        toast({ variant: "destructive", title: "Passkey verification failed", description: err?.message ?? "Try again." });
      }
    } finally {
      setStepUpBusy(null);
    }
  };

  const stepUpMethodLabel: Record<string, string> = {
    email_otp: "Email code",
    totp: "Authenticator app (2FA)",
    backup_code: "Backup code",
    passkey: "Passkey",
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signupOtp.trim() || signupOtp.length !== 6) {
      toast({ variant: "destructive", title: "Enter the 6-digit code" });
      return;
    }
    setLoading(true);
    try {
      const data = await backendRegister(username, email, password, signupOtp.trim());
      if (!data) {
        toast({ variant: "destructive", title: "Registration failed", description: "Server error. Try again." });
        setLoading(false);
        return;
      }
      if (data.error) {
        toast({ variant: "destructive", title: "Registration failed", description: data.error });
        if (data.error.toLowerCase().includes("code")) setSignupOtp("");
        setLoading(false);
        return;
      }
      setAuthContext(data.user, data.token);
      setSuccessMsg("Welcome to AYZEN, Operator!");
      setShowSuccess(true);
      setTimeout(() => setLocation("/dashboard"), 1800);
    } catch {
      toast({ variant: "destructive", title: "Registration failed", description: "Try again." });
    }
    setLoading(false);
  };

  const handleMagicLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) { toast({ variant: "destructive", title: "Enter your email" }); return; }
    setMagicLoading(true);
    try {
      const res = await fetch(`${BASE}/api/auth/magic-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ variant: "destructive", title: data.error ?? "Failed to send magic link" });
      } else {
        setMagicSent(true);
      }
    } catch {
      toast({ variant: "destructive", title: "Failed to send magic link" });
    }
    setMagicLoading(false);
  };

  const handleDemoAdmin = async () => {
    setLoading(true);
    const data = await backendLogin("demoadmin@ayzen.io", "Demo@1234");
    if (data) {
      setAuthContext(data.user, data.token);
      setSuccessMsg(`Welcome, ${data.user.username}!`);
      setShowSuccess(true);
      setTimeout(() => setLocation("/admin/dashboard"), 1600);
    } else {
      toast({ variant: "destructive", title: "Demo admin login failed" });
    }
    setLoading(false);
  };

  const handleDemoDev = async () => {
    setLoading(true);
    const data = await backendLogin("demodev@ayzen.io", "Demo@1234");
    if (data) {
      setAuthContext(data.user, data.token);
      setSuccessMsg(`Welcome, ${data.user.username}!`);
      setShowSuccess(true);
      setTimeout(() => setLocation("/admin/developer"), 1600);
    } else {
      toast({ variant: "destructive", title: "Demo developer login failed" });
    }
    setLoading(false);
  };

  const handleDemoModerator = async () => {
    setLoading(true);
    const data = await backendLogin("demomod@ayzen.io", "Demo@1234");
    if (data) {
      setAuthContext(data.user, data.token);
      setSuccessMsg(`Welcome, ${data.user.username}!`);
      setShowSuccess(true);
      setTimeout(() => setLocation("/dashboard"), 1600);
    } else {
      toast({ variant: "destructive", title: "Demo moderator login failed" });
    }
    setLoading(false);
  };

  const handleDemoTeamLeader = async () => {
    setLoading(true);
    const data = await backendLogin("demoteam@ayzen.io", "Demo@1234");
    if (data) {
      setAuthContext(data.user, data.token);
      setSuccessMsg(`Welcome, ${data.user.username}!`);
      setShowSuccess(true);
      setTimeout(() => setLocation("/teams"), 1600);
    } else {
      toast({ variant: "destructive", title: "Demo team leader login failed" });
    }
    setLoading(false);
  };

  const handleDemoUser = async () => {
    setLoading(true);
    const data = await backendLogin("demo@ayzen.io", "Demo@1234");
    if (data) {
      setAuthContext(data.user, data.token);
      setSuccessMsg(`Welcome, ${data.user.username}!`);
      setShowSuccess(true);
      setTimeout(() => setLocation("/dashboard"), 1600);
    } else {
      toast({ variant: "destructive", title: "Demo user login failed" });
    }
    setLoading(false);
  };

  const isLoading = loading;

  // 5d-c: while the cutover check is in flight, or once it's decided to
  // hand off to startSyloOidcLogin(), render the same full-screen loader
  // ProtectedRoute uses for the identical situation rather than this
  // page's own credential form — see the effect above for why.
  if (cutoverRedirectState !== "done") {
    return (
      <div className="zp-boot" role="status" aria-label="Loading">
        <i />
      </div>
    );
  }

  const view =
    tab === "magic" ? (magicSent ? "magic-code" : "magic")
    : tab === "signin" ? (signinStep === "stepup" && stepUp ? "stepup" : signinStep === "otp" ? "signin-otp" : "signin")
    : signupStep === "otp" ? "signup-otp" : "signup";
  const showTabs = view === "signin" || view === "signup" || view === "magic";
  const tabIndex = tab === "signin" ? 0 : tab === "signup" ? 1 : 2;
  const TABS: Array<{ id: "signin" | "signup" | "magic"; label: string }> = [
    { id: "signin", label: "Sign in" },
    { id: "signup", label: "Create account" },
    { id: "magic", label: "Email code" },
  ];
  const showPasskey = tab === "signin" && view === "signin" && browserSupportsWebAuthn();
  const showWorkspace = tab === "signin" && view === "signin" && !getCurrentSubdomainApp() && !oidcReturnTo;

  return (
    <div className="zp">
      <SuccessAnimation
        show={showSuccess}
        message={tab === "signup" ? "Account Created!" : "Access Granted!"}
        subMessage={successMsg}
        type={tab === "signup" ? "success" : "login"}
      />
      <AuthBackdrop nodes={PORTAL_NODES} className="zp-canvas" />

      <section className="zp-brand" aria-label="About AYZEN">
        <div className="zp-logo"><span>AYZEN</span><small>command center</small></div>
        <div className="zp-pitch">
          <h1>One sign-in.<br /><em>Every module</em> opens.</h1>
          <p>Vault, projects, teams, mail, wallet, finance and marketplace share one identity, so you sign in once and keep your place.</p>
          <div className="zp-status">Passkeys, email codes and new-location checks</div>
        </div>
      </section>

      <main className="zp-stage">
        <div className="zp-panel">
          {accounts?.length > 0 && showChooser ? (
            <div className="zp-view" key="chooser">
              <Heading title="Choose an account" sub="Pick up where you left off on this device." />
              <ul className="zp-accounts" style={{ listStyle: "none", padding: 0, margin: "0 0 14px" }}>
                {accounts.map((acc: any) => (
                  <li key={acc.id} className="zp-account">
                    <button type="button" onClick={() => { switchAccount(acc.id); setLocation("/"); }}>
                      <span className="zp-avatar" aria-hidden="true">{acc.username?.[0] || "U"}</span>
                      <span style={{ minWidth: 0 }}>
                        <strong>{acc.username}</strong>
                        <small>{acc.email}</small>
                      </span>
                    </button>
                    <button type="button" className="zp-x" onClick={() => removeAccount(acc.id)} aria-label={`Remove ${acc.username} from this browser`}>
                      <XIcon aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
              <Btn variant="ghost" block icon={<UserRound />} onClick={() => setShowChooser(false)}>Use another account</Btn>
            </div>
          ) : (
            <>
              {accounts?.length > 0 && (
                <Btn variant="ghost" className="zp-switch" icon={<UserRound />} style={{ height: 28, padding: "0 12px", fontSize: ".75rem", background: "#0c0c14" }} onClick={() => setShowChooser(true)}>
                  Switch account
                </Btn>
              )}

              {showTabs && (
                <div className="zp-tabs" role="tablist" aria-label="Access method" style={{ ["--i" as any]: tabIndex }}>
                  <i aria-hidden="true" />
                  {TABS.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      role="tab"
                      aria-selected={tab === t.id}
                      onClick={() => { setTab(t.id); if (t.id === "magic") setMagicSent(false); }}
                    >{t.label}</button>
                  ))}
                </div>
              )}

              <div className="zp-view" key={view}>
                {view === "magic" && (
                  <form onSubmit={handleMagicLink} className="zp-form">
                    <Heading title="Sign in with a code" sub="We email you a 6-digit code. No password needed." />
                    <Field label="Email" type="email" name="email" autoComplete="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
                    <Btn type="submit" block busy={magicLoading} icon={<Mail />}>Send code</Btn>
                  </form>
                )}

                {view === "magic-code" && (
                  <div className="zp-form">
                    <Heading title="Check your email" />
                    <Notice icon={<Mail />} title="Code sent to">{email}</Notice>
                    <form onSubmit={handleMagicVerify} className="zp-form">
                      <CodeField label="6-digit code" value={magicCode} onChange={setMagicCode} autoFocus />
                      <Btn type="submit" block busy={magicVerifyLoading} disabled={magicCode.length !== 6} icon={<ArrowRight />}>Verify and sign in</Btn>
                    </form>
                    <Btn variant="text" onClick={() => { setMagicSent(false); setMagicCode(""); setEmail(""); }}>Use a different email</Btn>
                  </div>
                )}

                {view === "stepup" && stepUp && (
                  <div className="zp-form">
                    <Heading title="Confirm it's you" />
                    <Notice tone="warn" icon={<Fingerprint />} title="New sign-in location detected">
                      Complete every check below to continue. This protects your account if someone else has your password.
                    </Notice>
                    <div className="zp-steps">
                      {stepUp.requiredMethods.map((method) => {
                        const done = stepUp.completedMethods.includes(method);
                        const busy = stepUpBusy === method;
                        const code =
                          method === "email_otp" ? { m: "email_otp" as const, value: stepUpEmailCode, set: setStepUpEmailCode, numeric: true }
                          : method === "totp" ? { m: "totp" as const, value: stepUpTotpCode, set: setStepUpTotpCode, numeric: true }
                          : method === "backup_code" ? { m: "backup_code" as const, value: stepUpBackupCode, set: setStepUpBackupCode, numeric: false }
                          : null;
                        const label = stepUpMethodLabel[method] ?? method;
                        return (
                          <div key={method} className={`zp-step${done ? " is-done" : ""}`}>
                            <div className="zp-step-head">
                              <span>{label}</span>
                              {done && <em>Verified</em>}
                            </div>
                            {!done && code && (
                              <div className="zp-step-body">
                                <input
                                  aria-label={label}
                                  type="text"
                                  inputMode={code.numeric ? "numeric" : "text"}
                                  autoComplete="one-time-code"
                                  placeholder={code.numeric ? "000000" : "XXXX-XXXX"}
                                  maxLength={code.numeric ? 6 : undefined}
                                  value={code.value}
                                  onChange={(e) => code.set(code.numeric ? e.target.value.replace(/\D/g, "") : e.target.value.toUpperCase())}
                                />
                                <Btn
                                  type="button"
                                  variant="ghost"
                                  busy={busy}
                                  disabled={code.numeric ? code.value.length !== 6 : !code.value.trim()}
                                  onClick={() => submitStepUpMethod(code.m, code.value)}
                                >Verify</Btn>
                              </div>
                            )}
                            {!done && method === "passkey" && (
                              <div className="zp-step-body">
                                <Btn type="button" variant="ghost" block busy={busy} icon={<Fingerprint />} onClick={submitStepUpPasskey}>Verify with passkey</Btn>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <Btn variant="text" onClick={() => { setStepUp(null); setSigninStep("form"); setStepUpEmailCode(""); setStepUpTotpCode(""); setStepUpBackupCode(""); }}>← Back to sign in</Btn>
                  </div>
                )}

                {view === "signin-otp" && (
                  <form onSubmit={handleSigninOtpVerify} className="zp-form">
                    <Heading title="Check your email" />
                    <Notice icon={<Mail />} title="Verification code sent to">{email}. It expires in 10 minutes.</Notice>
                    <CodeField label="6-digit code" value={signinOtp} onChange={setSigninOtp} autoFocus />
                    <Btn type="submit" block busy={signinOtpLoading} disabled={signinOtp.length !== 6} icon={<ArrowRight />}>Verify and sign in</Btn>
                    <div className="zp-row">
                      <button type="button" className="zp-link" onClick={() => { setSigninStep("form"); setSigninOtp(""); setTempSigninData(null); }}>← Back to sign in</button>
                      <button type="button" className="zp-link" onClick={handleResendSigninOtp} disabled={signinCountdown > 0 || signinOtpSending}>
                        {signinOtpSending ? "Sending…" : signinCountdown > 0 ? `Resend in ${signinCountdown}s` : "Resend code"}
                      </button>
                    </div>
                  </form>
                )}

                {view === "signup-otp" && (
                  <form onSubmit={handleSignUp} className="zp-form">
                    <Heading title="Verify your email" />
                    <Notice tone="ok" icon={<Check />} title="Verification code sent to">{email}</Notice>
                    <CodeField label="6-digit code" value={signupOtp} onChange={setSignupOtp} autoFocus />
                    <Btn type="submit" block busy={loading} disabled={signupOtp.length !== 6} icon={<ArrowRight />}>Create account</Btn>
                    <div className="zp-row">
                      <button type="button" className="zp-link" onClick={() => { setSignupStep("form"); setSignupOtp(""); }}>← Change details</button>
                      <button type="button" className="zp-link" onClick={handleResendSignupOtp} disabled={signupCountdown > 0 || signupSendingOtp}>
                        {signupSendingOtp ? "Sending…" : signupCountdown > 0 ? `Resend in ${signupCountdown}s` : "Resend code"}
                      </button>
                    </div>
                  </form>
                )}

                {(view === "signin" || view === "signup") && (
                  <form onSubmit={tab === "signin" ? handleSignIn : handleSendSignupOtp} className="zp-form">
                    <Heading
                      title={tab === "signin" ? "Welcome back" : "Create your account"}
                      sub={tab === "signin" ? "Sign in to continue to AYZEN." : "We'll email a code to confirm your address."}
                    />
                    {tab === "signup" && (
                      <Field
                        label="Username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false}
                        placeholder="your_handle" value={username} required
                        onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
                        hint="Lowercase letters, numbers and underscores."
                      />
                    )}
                    <Field
                      label={tab === "signin" ? "Email or identifier" : "Email"} type="email" name="email"
                      autoComplete={tab === "signin" ? "username" : "email"} placeholder="you@company.com"
                      value={email} onChange={(e) => setEmail(e.target.value)} required
                    />
                    <Field
                      label="Password" name="password" type={showPass ? "text" : "password"}
                      autoComplete={tab === "signin" ? "current-password" : "new-password"}
                      value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6}
                      aside={tab === "signin" ? <Link href="/forgot-password" className="zp-link">Forgot password?</Link> : undefined}
                      trailing={
                        <button type="button" className="zp-trail" onClick={() => setShowPass((p) => !p)} aria-label={showPass ? "Hide password" : "Show password"} aria-pressed={showPass}>
                          {showPass ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                        </button>
                      }
                    />
                    {tab === "signup" && (
                      <>
                        <Field
                          label="Referral code (optional)" name="refCode" autoComplete="off" autoCapitalize="characters" spellCheck={false}
                          placeholder="AYZNXXXXXX" value={refCode} onChange={(e) => setRefCode(e.target.value.toUpperCase())}
                          hint={refCode ? "This code will be applied when you register." : undefined}
                        />
                        <Field
                          label={`Security check: ${captcha.q} = ?`} type="number" inputMode="numeric" name="captcha" placeholder="Your answer"
                          value={captchaInput} onChange={(e) => { setCaptchaInput(e.target.value); setCaptchaError(false); }}
                          error={captchaError ? "That answer is wrong. Try the new question." : null}
                          aside={
                            <button type="button" className="zp-link" onClick={() => { setCaptcha(makeCaptcha()); setCaptchaInput(""); setCaptchaError(false); }}>
                              <RefreshCw style={{ width: 12, height: 12, display: "inline", marginRight: 4, verticalAlign: "-1px" }} aria-hidden="true" />New question
                            </button>
                          }
                          required
                        />
                      </>
                    )}
                    {tab === "signin" && (
                      <button type="button" className="zp-check" role="checkbox" aria-checked={keepSignedIn} onClick={() => setKeepSignedIn((p) => !p)}>
                        <b>{keepSignedIn && <Check aria-hidden="true" />}</b>
                        Keep me signed in on this device
                      </button>
                    )}
                    <Btn type="submit" block busy={loading || signupSendingOtp} disabled={isLoading} icon={tab === "signin" ? <ArrowRight /> : <Mail />}>
                      {tab === "signin" ? "Sign in" : "Send verification code"}
                    </Btn>
                  </form>
                )}

                {(showPasskey || showWorkspace) && (
                  <>
                    <Divider>or continue with</Divider>
                    <div className="zp-alt">
                      {showPasskey && (
                        <Btn type="button" variant="ghost" block busy={passkeyLoading} disabled={loading} icon={<Fingerprint />} onClick={handlePasskeySignIn}>Passkey</Btn>
                      )}
                      {showWorkspace && (
                        <Btn type="button" variant="ghost" block busy={workspaceOidcLoading} disabled={loading} icon={<Terminal />} onClick={handleWorkspaceOidcSignIn}>AYZEN workspace</Btn>
                      )}
                    </div>
                  </>
                )}
              </div>

              <details className="zp-dev">
                <summary>Developer access</summary>
                <div className="zp-dev-grid">
                  <Btn variant="ghost" onClick={handleDemoAdmin} disabled={isLoading}>Admin</Btn>
                  <Btn variant="ghost" onClick={handleDemoDev} disabled={isLoading}>Developer</Btn>
                  <Btn variant="ghost" onClick={handleDemoModerator} disabled={isLoading}>Moderator</Btn>
                  <Btn variant="ghost" onClick={handleDemoTeamLeader} disabled={isLoading}>Team leader</Btn>
                  <Btn variant="ghost" onClick={handleDemoUser} disabled={isLoading}>User</Btn>
                </div>
              </details>
            </>
          )}

          <p className="zp-foot">
            {tab === "signin" ? <>New to AYZEN? <button type="button" onClick={() => setTab("signup")}>Request access</button></>
              : tab === "signup" ? <>Already have access? <button type="button" onClick={() => setTab("signin")}>Sign in</button></>
              : <>Prefer a password? <button type="button" onClick={() => setTab("signin")}>Sign in</button></>}
          </p>
        </div>
      </main>
    </div>
  );
}
