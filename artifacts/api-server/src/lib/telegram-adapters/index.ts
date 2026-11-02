import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { signAuthToken } from "../jwt";
import { resolveSessionScopes } from "../policy/rbac/session-scopes";
import { telegramLinks } from "../telegram-link-service";
import { createDomainCommandAdapter, type DomainCommandAdapterOptions, type TelegramCommandAdapter } from "../telegram-command-adapter";

/**
 * Telegram chat -> linked AYZEN account, PER BOT (telegram_bot_links, Phase 4).
 * The sender must be the Telegram user who completed the link. Banned or
 * suspended accounts resolve to null; a link the user switched off resolves
 * to `{ inactive: true }`. There is deliberately no fallback to the legacy
 * AYZENX link (users.telegram_chat_id): each module bot is linked on its own.
 */
const resolveIdentityFor = (botKey: string): NonNullable<DomainCommandAdapterOptions["resolveIdentity"]> => async ({ telegramUserId, chatId }) => {
  if (chatId === undefined) return null;
  const resolution = await telegramLinks.resolveChat({ botKey, chatId: String(chatId), telegramUserId: String(telegramUserId) });
  if (resolution.kind === "unlinked") return null;
  if (resolution.kind === "inactive") return { inactive: true };
  const [user] = await db
    .select({ id: usersTable.id, role: usersTable.role, status: usersTable.status })
    .from(usersTable)
    .where(eq(usersTable.id, resolution.link.userId))
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
  createDomainCommandAdapter({ botKey, resolveIdentity: resolveIdentityFor(botKey), issueToken, ...extra });

export const TELEGRAM_ADAPTERS: Readonly<Record<string, TelegramCommandAdapter>> = Object.freeze({
  warde: adapter("warde"),
  verve: adapter("verve"),
  ryft: adapter("ryft"),
  fyra: adapter("fyra"),
  sylo: adapter("sylo"),
  skarn: adapter("skarn"),
  zynth: adapter("zynth"),
  wisp: adapter("wisp"),
  admin: adapter("admin", { adminOwnerId: process.env.TELEGRAM_ADMIN_OWNER_ID }),
});
