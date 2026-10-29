import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { signAuthToken } from "../jwt";
import { resolveSessionScopes } from "../policy/rbac/session-scopes";
import { createDomainCommandAdapter, type DomainCommandAdapterOptions, type TelegramCommandAdapter } from "../telegram-command-adapter";

/** Telegram user -> linked AYZEN account (users.telegram_chat_id, set by the /link flow). Banned/suspended accounts resolve to null. */
const resolveIdentity: NonNullable<DomainCommandAdapterOptions["resolveIdentity"]> = async ({ chatId }) => {
  if (chatId === undefined) return null;
  const [user] = await db
    .select({ id: usersTable.id, role: usersTable.role, status: usersTable.status })
    .from(usersTable)
    .where(eq(usersTable.telegramChatId, String(chatId)))
    .limit(1);
  if (!user || user.status === "banned" || user.status === "suspended") return null;
  return { userId: user.id, role: user.role };
};

// One command = one request, so the token only needs to outlive that request.
//
// AK4 Phase 1c: mints real scopes/roles (resolveSessionScopes()), same as
// every other token-issuing path since H14 — see routes/auth.ts's
// mintSessionToken() for the precedent. `stepUpAt` is set to "now" for
// observability consistency with that same precedent, not because a
// Telegram command is itself a fresh-credential-verification event (it
// isn't — /link is where the account was originally verified); given the
// 60s token lifetime the practical step-up window this opens is minor,
// per the roadmap's own note, but it keeps this path's claims shaped
// identically to every other issuer instead of a token that always
// resolves the same way a differently-shaped one would.
const issueToken: NonNullable<DomainCommandAdapterOptions["issueToken"]> = async (identity) => {
  const { scopes, roles } = await resolveSessionScopes(identity.userId, identity.role);
  return signAuthToken(identity.userId, identity.role, { expiresIn: "60s", scopes, roles, stepUpAt: new Date().toISOString() });
};

const adapter = (botKey: string, extra: Partial<DomainCommandAdapterOptions> = {}) =>
  createDomainCommandAdapter({ botKey, resolveIdentity, issueToken, ...extra });

export const TELEGRAM_ADAPTERS: Readonly<Record<string, TelegramCommandAdapter>> = Object.freeze({
  warde: adapter("warde"),
  verve: adapter("verve"),
  ryft: adapter("ryft"),
  sylo: adapter("sylo"),
  skarn: adapter("skarn"),
  zynth: adapter("zynth"),
  wisp: adapter("wisp"),
  admin: adapter("admin", { adminOwnerId: process.env.TELEGRAM_ADMIN_OWNER_ID }),
});
