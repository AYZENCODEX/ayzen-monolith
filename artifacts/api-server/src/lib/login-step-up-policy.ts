/** Pure policy helpers: no DB imports, so they can be unit tested in isolation. */
// ─── Step-up policy ──────────────────────────────────────────────────────────
// "always" (default): every password login must clear the account's step-up
// chain (email code, plus authenticator / passkey when set up) before a
// session exists. "anomalous": the previous behaviour, chain only on a new IP.
export type StepUpPolicy = "always" | "anomalous";

/** Seeded demo accounts (routes/auth.ts) sign in with the demo buttons and never have a mailbox. */
export const DEMO_LOGIN_EMAILS: ReadonlySet<string> = new Set([
  "demoadmin@ayzen.io", "demodev@ayzen.io", "demomod@ayzen.io", "demoteam@ayzen.io", "demo@ayzen.io",
]);

export function getStepUpPolicy(env: NodeJS.ProcessEnv = process.env): StepUpPolicy {
  return env.LOGIN_STEP_UP_POLICY === "anomalous" ? "anomalous" : "always";
}

export function loginNeedsStepUp(opts: { policy: StepUpPolicy; email: string; anomalousIp: boolean }): boolean {
  if (DEMO_LOGIN_EMAILS.has(opts.email.trim().toLowerCase())) return opts.anomalousIp && opts.policy === "anomalous";
  return opts.policy === "always" || opts.anomalousIp;
}
