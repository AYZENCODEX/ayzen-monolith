/**
 * Signup input rules shared by POST /auth/register and the public
 * username-availability check, so the form and the server cannot drift.
 */

const USERNAME_RE = /^[a-z0-9_]{3,30}$/;

// Names that must not be registrable: they double as the local part of an
// AYZEN mail address by default (username@ayzen.tech) and read as official.
const RESERVED = new Set([
  "admin", "administrator", "root", "support", "help", "security", "abuse", "postmaster",
  "hostmaster", "webmaster", "noreply", "no_reply", "mailer_daemon", "ayzen", "official", "staff", "system",
]);

/** Returns a user-facing reason, or null when the username is acceptable. */
export function validateUsername(raw: unknown): string | null {
  if (typeof raw !== "string") return "Username is required.";
  const u = raw.trim();
  if (u !== u.toLowerCase()) return "Use lowercase letters only.";
  if (!USERNAME_RE.test(u)) return "Use 3-30 lowercase letters, numbers or underscores.";
  if (RESERVED.has(u)) return "That username is reserved.";
  return null;
}

/** Display name: trimmed, whitespace collapsed, max 60 chars; empty becomes null. */
export function normalizeDisplayName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const n = raw.replace(/\s+/g, " ").trim().slice(0, 60);
  return n || null;
}
