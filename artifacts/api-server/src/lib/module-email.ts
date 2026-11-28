/**
 * lib/module-email.ts: branded one-time-code emails for module accounts (Sylo, Ryft, Fyra, …).
 * One layout, coloured from the module's own brand tokens (landing content), with copy per category
 * (sign-up, sign-in, password reset). Inline styles + tables only, so it renders in mail clients.
 */
import { getLandingContent } from "@ayzen/module-registry/landing";

export type ModuleMailKind = "sign-up" | "sign-in" | "password reset";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const COPY: Record<ModuleMailKind, { subject: (l: string, c: string) => string; eyebrow: string; title: (l: string) => string; lead: (l: string) => string }> = {
  "sign-up": {
    subject: (l, c) => `${c} is your ${l} sign-up code`,
    eyebrow: "Create your account",
    title: (l) => `Welcome to ${l}`,
    lead: (l) => `Use this code to confirm your email and finish creating your ${l} account.`,
  },
  "sign-in": {
    subject: (l, c) => `${c} is your ${l} sign-in code`,
    eyebrow: "Sign-in",
    title: (l) => `Confirm it's you`,
    lead: (l) => `Enter this code to sign in to ${l}.`,
  },
  "password reset": {
    subject: (l, c) => `${c} is your ${l} password reset code`,
    eyebrow: "Password reset",
    title: () => `Reset your password`,
    lead: (l) => `Use this code to choose a new ${l} password.`,
  },
};

export function moduleCodeEmail(moduleId: string, kind: ModuleMailKind, code: string, ttlMinutes: number): { subject: string; html: string; text: string } {
  const c = getLandingContent(moduleId);
  const label = c?.label ?? moduleId;
  const b = c?.brand ?? { bg: "#0f1213", surface: "#171c1e", fg: "#e9e3d3", muted: "#9a9a90", accent: "#c29a52", ink: "#0f1213" };
  const t = COPY[kind];
  const title = t.title(label), lead = t.lead(label);
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:${b.bg}">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${b.bg};padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:480px;background:${b.surface};border:1px solid ${b.accent}33;border-radius:14px">
<tr><td style="padding:24px 28px 0;font:700 18px/1 Georgia,serif;letter-spacing:.18em;color:${b.accent}">${esc(label.toUpperCase())}</td></tr>
<tr><td style="padding:22px 28px 0;font:600 11px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.14em;text-transform:uppercase;color:${b.muted}">${esc(t.eyebrow)}</td></tr>
<tr><td style="padding:8px 28px 0;font:600 24px/1.25 Georgia,serif;color:${b.fg}">${esc(title)}</td></tr>
<tr><td style="padding:10px 28px 0;font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;color:${b.muted}">${esc(lead)}</td></tr>
<tr><td style="padding:20px 28px 0"><div style="display:inline-block;padding:14px 22px;border-radius:10px;background:${b.accent};color:${b.ink};font:700 30px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.32em">${esc(code)}</div></td></tr>
<tr><td style="padding:18px 28px 0;font:13px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;color:${b.muted}">It expires in ${ttlMinutes} minutes and works once.</td></tr>
<tr><td style="padding:14px 28px 26px;font:12px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;color:${b.muted}">Didn't ask for this? You can ignore this email. Nobody can use the code without your email access. ${esc(label)} will never ask you for it.</td></tr>
</table></td></tr></table></body></html>`;
  const text = `${title}\n\n${lead}\n\nCode: ${code}\nIt expires in ${ttlMinutes} minutes and works once.\n\nDidn't ask for this? Ignore this email. ${label} will never ask you for the code.`;
  return { subject: t.subject(label, code), html, text };
}
