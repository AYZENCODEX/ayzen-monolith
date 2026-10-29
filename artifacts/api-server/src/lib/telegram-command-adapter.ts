import { getCapability, listTelegramCommands } from "@ayzen/capabilities";
import { normalizeTelegramMessage, renderCommandTreeHelp, renderSubcommandHelp, resolveCommandTreePath } from "@ayzen/telegram";
import type { TelegramUpdateEnvelope } from "./telegram-gateway";

export interface TelegramAdapterContext {
  envelope: TelegramUpdateEnvelope;
  message: ReturnType<typeof normalizeTelegramMessage>;
  command: string;
  args: string[];
  botKey: string;
  requestId: string;
  getFailures?: () => Promise<unknown[]>;
}

export interface TelegramCommandAdapter {
  botKey: string;
  handle(context: TelegramAdapterContext): Promise<{ status: number; body: Record<string, unknown> }>;
}

/** An AYZEN account that the Telegram user has explicitly linked. */
export interface TelegramLinkedIdentity {
  userId: number;
  role: string;
}

export interface DomainCommandAdapterOptions {
  botKey: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Telegram user id of the only person allowed to use the admin bot. Unset = admin bot denies everyone. */
  adminOwnerId?: string;
  /** Maps a Telegram user to a linked AYZEN account (or null when not linked / suspended). */
  resolveIdentity?: (input: { telegramUserId: number; chatId?: number }) => Promise<TelegramLinkedIdentity | null>;
  /**
   * Mints a short-lived bearer token for the linked account. Async since
   * AK4 Phase 1c: the real implementation (telegram-adapters/index.ts)
   * resolves the caller's current RBAC grants via `resolveSessionScopes()`
   * before minting, the same `stepUpAt`/`scopes`/`roles` claims
   * `routes/auth.ts`'s `mintSessionToken()` sets for every other
   * token-issuing path — see that file for the precedent this mirrors.
   */
  issueToken?: (identity: TelegramLinkedIdentity) => Promise<string>;
  requestTimeoutMs?: number;
}

const SAFE_PATH_PARAM = /^[A-Za-z0-9_-]{1,128}$/;

type PathResult = { ok: true; route: string; remainingArgs: string[] } | { ok: false; code: string };

function pathParamsFor(route: string, args: string[]): PathResult {
  const remainingArgs = [...args];
  let missing = false;
  let invalid = false;
  const resolved = route.replace(/:([A-Za-z0-9_]+)/g, (match) => {
    const value = remainingArgs.shift();
    if (value === undefined) { missing = true; return match; }
    // Reject "." / ".." and anything outside a strict charset: a value like ".."
    // survives encodeURIComponent and would let fetch() normalise the request
    // onto a different route than the capability declared.
    if (!SAFE_PATH_PARAM.test(value)) { invalid = true; return match; }
    return value;
  });
  if (invalid) return { ok: false, code: "TELEGRAM_ARGUMENT_INVALID" };
  if (missing) return { ok: false, code: "TELEGRAM_ARGUMENT_REQUIRED" };
  return { ok: true, route: resolved, remainingArgs };
}

const deny = (status: number, code: string, extra: Record<string, unknown> = {}) => ({ status, body: { accepted: false, code, ...extra } });

export function createDomainCommandAdapter({
  botKey,
  apiBaseUrl = process.env.TELEGRAM_ADAPTER_API_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8080}`,
  fetchImpl = fetch,
  adminOwnerId,
  resolveIdentity,
  issueToken,
  requestTimeoutMs = 10_000,
}: DomainCommandAdapterOptions): TelegramCommandAdapter {
  return {
    botKey,
    async handle(context) {
      const message = context.message;
      if (!message) return deny(400, "TELEGRAM_MESSAGE_REQUIRED");

      // The admin bot is a privileged control plane: fail CLOSED. Previously an
      // unset owner id meant every Telegram user passed this check.
      if (botKey === "admin" && (!adminOwnerId || String(message.telegramUserId) !== String(adminOwnerId))) {
        return deny(403, "ADMIN_TELEGRAM_OWNER_REQUIRED");
      }

      if (context.command === "/start") {
        return { status: 200, body: { botKey, message: `Link your AYZEN account from Settings, then use /help to see the ${botKey} commands.` } };
      }
      if (context.command === "/help") {
        return {
          status: 200,
          body: {
            botKey,
            // Deprecated flat aliases keep working but are not advertised.
            commands: listTelegramCommands({ bot: botKey }).filter((entry) => !entry.deprecated).map(({ command, capability }) => ({ command, capability })),
            message: renderCommandTreeHelp(botKey) ?? `Available ${botKey} commands`,
          },
        };
      }

      // The hierarchical parser is strictly bot-scoped (a command owned by another
      // bot, e.g. /breakglass sent to warde, does not resolve) and walks
      // sub-features: "/data write foo" -> admin.data-write with args ["foo"].
      const resolved = resolveCommandTreePath([context.command, ...context.args].join(" "), { botKey });
      if (!resolved?.capability || resolved.bot !== botKey) return deny(400, "TELEGRAM_COMMAND_NOT_REGISTERED", { command: context.command });
      // "/vault help" lists sub-features locally. Only an exact bare "help" on a
      // parent counts: "/vault reveal help" has path ["reveal"] and is a secret id.
      if (resolved.hasSubcommands && resolved.path.length === 0 && resolved.args.length === 1 && resolved.args[0].toLowerCase() === "help") {
        return { status: 200, body: { botKey, message: renderSubcommandHelp(botKey, resolved.command ?? context.command) } };
      }
      const deprecation = resolved.deprecated ? { deprecated: true, replacement: resolved.replacement } : {};
      const capabilityKey = resolved.capability;
      if (!capabilityKey) return deny(400, "TELEGRAM_CAPABILITY_NOT_REGISTERED", { capability: resolved.capability });
      const capability = getCapability(capabilityKey);
      if (!capability) return deny(400, "TELEGRAM_CAPABILITY_NOT_REGISTERED", { capability: resolved.capability });
      if (["missing", "deprecated", "internal"].includes(capability.status)) {
        return deny(501, "TELEGRAM_CAPABILITY_NOT_AVAILABLE", { capability: capability.capability, capabilityStatus: capability.status });
      }

      if (!resolveIdentity || !issueToken) return deny(503, "TELEGRAM_AUTH_NOT_CONFIGURED");
      // Private chats only: in a group, chat.id is the group, so it can never
      // equal the sender's user id. This stops a group from borrowing a link.
      if (message.chatId === undefined || String(message.chatId) !== String(message.telegramUserId)) {
        return deny(403, "TELEGRAM_PRIVATE_CHAT_REQUIRED");
      }
      const identity = await resolveIdentity({ telegramUserId: message.telegramUserId, chatId: message.chatId });
      if (!identity) return deny(403, "TELEGRAM_ACCOUNT_NOT_LINKED");
      if (botKey === "admin" && identity.role !== "admin") return deny(403, "ADMIN_ROLE_REQUIRED");

      if (context.command === "/gaps" || context.command === "/alerts") {
        return { status: 200, body: { accepted: true, botKey, command: context.command, capability: capability.capability, failures: await context.getFailures?.() ?? [], ...deprecation } };
      }

      const path = pathParamsFor(capability.route, resolved.args);
      if (!path.ok) return deny(400, path.code, { capability: capability.capability });
      const baseUrl = apiBaseUrl.replace(/\/+$/, "");
      const response = await fetchImpl(`${baseUrl}${path.route}`, {
        method: capability.method,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${await issueToken(identity)}`,
          "x-request-id": context.requestId,
          "x-correlation-id": context.requestId,
          "x-telegram-bot-key": botKey,
        },
        signal: AbortSignal.timeout(requestTimeoutMs),
        ...(capability.method === "GET" ? {} : { body: JSON.stringify({ args: path.remainingArgs, source: "telegram", botKey }) }),
      });
      const body = await response.json().catch(() => ({}));
      return { status: response.status, body: { accepted: response.ok, botKey, command: context.command, capability: capability.capability, capabilityStatus: capability.status, result: body, ...deprecation } };
    },
  };
}
