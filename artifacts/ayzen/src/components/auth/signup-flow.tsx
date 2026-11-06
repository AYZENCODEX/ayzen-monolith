import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ArrowRight, Check, Eye, EyeOff, Mail, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { getApiBase } from "@/lib/api-base";
import { Btn, CodeField, Field, Heading, Notice, Stepper } from "./portal";

/**
 * Sign-up, one decision per screen:
 *   1 Account   email + password
 *   2 Checks    referral code + captcha, then we email a code
 *   3 Email     6-digit code -> server returns a one-time proof of the address
 *   4 Identity  username, name, AYZEN mail address -> account is created
 *   5 Profile   optional details, skippable
 *
 * The session is only handed to the app (onComplete) after step 5, so the
 * login page's own "already signed in" redirect cannot cut the flow short.
 */

const BASE = getApiBase();
const STEPS = ["Account", "Security check", "Verify email", "Identity", "Profile"];
type Step = 0 | 1 | 2 | 3 | 4;

function makeCaptcha() {
  const a = 2 + Math.floor(Math.random() * 8), b = 2 + Math.floor(Math.random() * 8);
  return { q: `${a} × ${b}`, ans: a * b };
}

const cleanUsername = (v: string) => v.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 30);
const cleanMailUser = (v: string) => v.toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 30);

type Availability = { state: "idle" | "checking" | "ok" | "bad"; reason?: string; email?: string };

/** Debounced availability lookup; ignores out-of-order responses. */
function useAvailability(value: string, url: (v: string) => string, minLen: number): Availability {
  const [a, setA] = useState<Availability>({ state: "idle" });
  const seq = useRef(0);
  useEffect(() => {
    if (value.length < minLen) { setA({ state: "idle" }); return; }
    const id = ++seq.current;
    setA({ state: "checking" });
    const t = setTimeout(async () => {
      try {
        const r = await fetch(url(value));
        const d = await r.json();
        if (id !== seq.current) return;
        setA(d.available ? { state: "ok", email: d.email } : { state: "bad", reason: d.reason ?? "Not available." });
      } catch {
        if (id === seq.current) setA({ state: "idle" });
      }
    }, 350);
    return () => clearTimeout(t);
  }, [value, url, minLen]);
  return a;
}

interface Props {
  onComplete: (user: any, token: string) => void;
  onSwitchToSignIn: () => void;
}

export function SignupFlow({ onComplete }: Props) {
  const { toast } = useToast();
  const [step, setStep] = useState<Step>(0);
  const [busy, setBusy] = useState(false);

  // 1
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  // 2
  const [refCode, setRefCode] = useState(() => (typeof window === "undefined" ? "" : (new URLSearchParams(window.location.search).get("ref") ?? "").toUpperCase().slice(0, 20)));
  const [captcha, setCaptcha] = useState(makeCaptcha);
  const [captchaInput, setCaptchaInput] = useState("");
  const [captchaError, setCaptchaError] = useState(false);
  // 3
  const [code, setCode] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [emailProof, setEmailProof] = useState("");
  // 4
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [mailUser, setMailUser] = useState("");
  const [mailTouched, setMailTouched] = useState(false);
  // 5
  const [session, setSession] = useState<{ user: any; token: string } | null>(null);
  const [profile, setProfile] = useState({ location: "", bio: "", twitterHandle: "", telegramHandle: "", discordHandle: "", websiteUrl: "" });

  useEffect(() => {
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  // The mail address follows the username until the person edits it.
  useEffect(() => { if (!mailTouched) setMailUser(cleanMailUser(username)); }, [username, mailTouched]);

  const userUrl = useMemo(() => (v: string) => `${BASE}/api/auth/username-available/${encodeURIComponent(v)}`, []);
  const mailUrl = useMemo(() => (v: string) => `${BASE}/api/ayzen-email/check/${encodeURIComponent(v)}`, []);
  const userAvail = useAvailability(username, userUrl, 3);
  const mailAvail = useAvailability(mailUser, mailUrl, 3);

  const fail = (title: string, description?: string) => toast({ variant: "destructive", title, description });
  const post = async (path: string, body: unknown, token?: string) => {
    const r = await fetch(`${BASE}/api${path}`, {
      method: path === "/profile" ? "PUT" : "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    let data: any = {};
    try { data = await r.json(); } catch { /* empty body */ }
    return { ok: r.ok, status: r.status, data };
  };

  // 1 → 2
  const submitAccount = (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 6) { fail("Password too short", "Use at least 6 characters."); return; }
    setStep(1);
  };

  // 2 → 3 (sends the email code)
  const sendCode = async () => {
    setBusy(true);
    try {
      const { ok, data } = await post("/auth/send-otp", { email });
      if (ok) { setCountdown(60); setCode(""); setStep(2); toast({ title: "Code sent", description: `Check ${email}.` }); }
      else fail("Could not send the code", data.error ?? "Try again.");
    } catch { fail("Connection error"); }
    setBusy(false);
  };
  const submitChecks = (e: FormEvent) => {
    e.preventDefault();
    if (parseInt(captchaInput, 10) !== captcha.ans) {
      setCaptchaError(true); setCaptcha(makeCaptcha()); setCaptchaInput(""); return;
    }
    setCaptchaError(false);
    void sendCode();
  };

  // 3 → 4
  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    if (code.length !== 6) return;
    setBusy(true);
    try {
      const { ok, data } = await post("/auth/signup/verify-email", { email, code });
      if (ok && data.emailProof) { setEmailProof(data.emailProof); setStep(3); }
      else { fail(data.error ?? "Invalid code"); setCode(""); }
    } catch { fail("Connection error"); }
    setBusy(false);
  };

  // 4 → 5 (creates the account, then claims the mail address)
  const submitIdentity = async (e: FormEvent) => {
    e.preventDefault();
    if (userAvail.state === "bad") { fail("Pick another username", userAvail.reason); return; }
    setBusy(true);
    try {
      const reg = await post("/auth/register", { username, email, password, emailProof, displayName, ...(refCode ? { refCode } : {}) });
      if (!reg.ok) {
        if (reg.status === 409 && /email/i.test(reg.data.error ?? "")) { fail("Email already registered", "Sign in instead."); setStep(0); }
        else if (/verification|code/i.test(reg.data.error ?? "")) { fail("Verification expired", "Request a new code."); setStep(2); setCode(""); }
        else fail("Could not create the account", reg.data.error);
        setBusy(false);
        return;
      }
      const { token, user } = reg.data;
      if (mailUser.length >= 3) {
        const claim = await post("/ayzen-email/claim-native", { username: mailUser }, token);
        if (!claim.ok) toast({ title: "Account created", description: `${mailUser}@ayzen.tech wasn't set up (${claim.data.error ?? "try again in Wisp"}). You can claim it later in Wisp.` });
      }
      setSession({ user, token });
      setStep(4);
    } catch { fail("Connection error", "Nothing was created. Try again."); }
    setBusy(false);
  };

  // 5
  const finish = (u = session) => { if (u) onComplete(u.user, u.token); };
  const saveProfile = async (e: FormEvent) => {
    e.preventDefault();
    if (!session) return;
    const body = Object.fromEntries(Object.entries(profile).filter(([, v]) => v.trim()));
    if (Object.keys(body).length) {
      setBusy(true);
      try {
        const { ok, data } = await post("/profile", body, session.token);
        if (!ok) { fail("Profile not saved", data.error ?? "You can finish it later in settings."); }
      } catch { fail("Profile not saved", "You can finish it later in settings."); }
      setBusy(false);
    }
    finish();
  };
  const setP = (k: keyof typeof profile) => (e: React.ChangeEvent<HTMLInputElement>) => setProfile((p) => ({ ...p, [k]: e.target.value }));

  const mailDomainHint =
    mailUser.length < 3 ? "At least 3 characters." :
    mailAvail.state === "checking" ? "Checking…" :
    mailAvail.state === "bad" ? mailAvail.reason ?? "Not available." :
    mailAvail.state === "ok" ? `${mailAvail.email ?? `${mailUser}@ayzen.tech`} is available.` : "";

  return (
    <div className="zp-form">
      <Stepper steps={STEPS} current={step} />

      {step === 0 && (
        <form className="zp-form" onSubmit={submitAccount}>
          <Heading title="Create your account" sub="Start with your email and a password." />
          <Field label="Email" type="email" name="email" autoComplete="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          <Field
            label="Password" name="new-password" type={showPass ? "text" : "password"} autoComplete="new-password" minLength={6}
            value={password} onChange={(e) => setPassword(e.target.value)} hint="At least 6 characters." required
            trailing={<button type="button" className="zp-trail" onClick={() => setShowPass((p) => !p)} aria-label={showPass ? "Hide password" : "Show password"} aria-pressed={showPass}>{showPass ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}</button>}
          />
          <Btn type="submit" block icon={<ArrowRight />}>Continue</Btn>
        </form>
      )}

      {step === 1 && (
        <form className="zp-form" onSubmit={submitChecks}>
          <Heading title="One quick check" sub="Add a referral code if you have one, then prove you're human. We email a code next." />
          <Field label="Referral code (optional)" name="refCode" autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="AYZNXXXXXX" value={refCode} onChange={(e) => setRefCode(e.target.value.toUpperCase())} hint={refCode ? "This code is applied when your account is created." : undefined} />
          <Field
            label={`Security check: ${captcha.q} = ?`} type="number" inputMode="numeric" name="captcha" placeholder="Your answer"
            value={captchaInput} onChange={(e) => { setCaptchaInput(e.target.value); setCaptchaError(false); }}
            error={captchaError ? "That answer is wrong. Try the new question." : null} required
            aside={<button type="button" className="zp-link" onClick={() => { setCaptcha(makeCaptcha()); setCaptchaInput(""); setCaptchaError(false); }}><RefreshCw style={{ width: 12, height: 12, display: "inline", marginRight: 4, verticalAlign: "-1px" }} aria-hidden="true" />New question</button>}
          />
          <Btn type="submit" block busy={busy} icon={<Mail />}>Send verification code</Btn>
          <Btn variant="text" type="button" onClick={() => setStep(0)}>← Back</Btn>
        </form>
      )}

      {step === 2 && (
        <form className="zp-form" onSubmit={submitCode}>
          <Heading title="Verify your email" />
          <Notice tone="ok" icon={<Check />} title="Code sent to">{email}. It expires in 10 minutes.</Notice>
          <CodeField label="6-digit code" value={code} onChange={setCode} autoFocus />
          <Btn type="submit" block busy={busy} disabled={code.length !== 6} icon={<ArrowRight />}>Verify email</Btn>
          <div className="zp-row">
            <button type="button" className="zp-link" onClick={() => { setStep(0); setCode(""); }}>← Change email</button>
            <button type="button" className="zp-link" disabled={countdown > 0 || busy} onClick={() => void sendCode()}>{countdown > 0 ? `Resend in ${countdown}s` : "Resend code"}</button>
          </div>
        </form>
      )}

      {step === 3 && (
        <form className="zp-form" onSubmit={submitIdentity}>
          <Heading title="Choose your identity" sub="Your username also becomes your AYZEN mail address." />
          <div>
            <Field label="Username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="your_handle" value={username} onChange={(e) => setUsername(cleanUsername(e.target.value))} required minLength={3} autoFocus />
            <p className={`zp-status-line${userAvail.state === "ok" ? " ok" : userAvail.state === "bad" ? " bad" : ""}`} aria-live="polite">
              {userAvail.state === "checking" ? "Checking…" : userAvail.state === "ok" ? "Available." : userAvail.state === "bad" ? userAvail.reason : "3-30 lowercase letters, numbers or underscores."}
            </p>
          </div>
          <Field label="Full name" name="name" autoComplete="name" placeholder="Your name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={60} />
          <div>
            <Field
              label="AYZEN mail address" name="mail-username" autoComplete="off" autoCapitalize="none" spellCheck={false}
              value={mailUser} onChange={(e) => { setMailTouched(true); setMailUser(cleanMailUser(e.target.value)); }}
              trailing={<span className="zp-suffix">@ayzen.tech</span>}
            />
            <p className={`zp-status-line${mailAvail.state === "ok" ? " ok" : mailAvail.state === "bad" ? " bad" : ""}`} aria-live="polite">{mailDomainHint}</p>
          </div>
          <Btn type="submit" block busy={busy} disabled={userAvail.state === "checking" || userAvail.state === "bad"} icon={<ArrowRight />}>Create account</Btn>
        </form>
      )}

      {step === 4 && (
        <form className="zp-form" onSubmit={saveProfile}>
          <Heading title="Finish your profile" sub="Everything here is optional. You can change it later." />
          <Field label="Location" autoComplete="address-level2" value={profile.location} onChange={setP("location")} maxLength={100} placeholder="City, country" />
          <Field label="Short bio" value={profile.bio} onChange={setP("bio")} maxLength={300} placeholder="What you work on" />
          <Field label="X (Twitter) handle" autoCapitalize="none" spellCheck={false} value={profile.twitterHandle} onChange={setP("twitterHandle")} placeholder="@handle" />
          <Field label="Telegram username" autoCapitalize="none" spellCheck={false} value={profile.telegramHandle} onChange={setP("telegramHandle")} placeholder="@handle" />
          <Field label="Discord" autoCapitalize="none" spellCheck={false} value={profile.discordHandle} onChange={setP("discordHandle")} placeholder="username" />
          <Field label="Website" type="url" inputMode="url" value={profile.websiteUrl} onChange={setP("websiteUrl")} placeholder="https://" />
          <Btn type="submit" block busy={busy} icon={<ArrowRight />}>Save and continue</Btn>
          <Btn variant="ghost" type="button" block disabled={busy} onClick={() => finish()}>Skip for now</Btn>
        </form>
      )}
    </div>
  );
}
