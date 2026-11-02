/**
 * Gateway dispatch for the module bots (everything except AYZENX).
 *
 * Shared by the webhook route and the polling launcher so both transports go
 * through the same path: dedupe -> account-link commands -> domain adapter ->
 * a visible reply in the chat. Pure over injected dependencies (no DB import)
 * so it is unit-testable; lib/telegram-gateway-runtime.ts wires the real ones.
 */
import crypto from "node:crypto";
import { normalizeTelegramMessage } from "@ayzen/telegram";
import type { TelegramUpdateEnvelope } from "./telegram-gateway";
import type { TelegramCommandAdapter } from "./telegram-command-adapter";
import type { TelegramLinkService } from "./telegram-bot-links";
import { formatLinkCode } from "./telegram-bot-links";
import { getTelegramBotDescriptor } from "./telegram-bot-registry";

export interface GatewayResult { status: number; body: Record<string, unknown> }

export interface GatewayDispatcherDeps {
  claim: (envelope: TelegramUpdateEnvelope) => Promise<boolean>;
  mark: (envelope: TelegramUpdateEnvelope, status: "processing" | "completed" | "failed", error?: string) => Promise<void>;
  links: TelegramLinkService;
  adapters: Readonly<Record<string, TelegramCommandAdapter>>;
  /** Sends a plain-text message to a chat; resolves false when delivery failed. */
  sendReply: (botKey: string, chatId: string, text: string) => Promise<boolean>;
  getFailures: () => Promise<unknown[]>;
  adminOwnerId: () => string | undefined;
}

const LINK_CODE_SHAPE = /^[A-Za-z0-9-]{6,16}$/;

function friendlyReply(botName: string, result: GatewayResult, command: string): string | null {
  const code = typeof result.body.code === "string" ? result.body.code : undefined;
  switch (code) {
    case "TELEGRAM_ACCOUNT_NOT_LINKED":
      return `🔗 This chat is not linked to an AYZEN account yet.\n\nOpen AYZEN → ${botName} → Settings → Telegram and press Connect, or send /connect here to get a code.`;
    case "TELEGRAM_BOT_INACTIVE":
      return `⏸ ${botName} is switched off for your account. Turn it on in AYZEN → ${botName} → Settings → Telegram.`;
    case "TELEGRAM_PRIVATE_CHAT_REQUIRED":
      return "🔒 Please message me in a private chat — commands are not accepted in groups.";
    case "TELEGRAM_COMMAND_NOT_REGISTERED":
      return `Unknown command ${command}. Send /help to see what ${botName} can do.`;
    case "TELEGRAM_ARGUMENT_REQUIRED":
    case "TELEGRAM_ARGUMENT_INVALID":
      return `That command needs a valid argument. Send /help for usage.`;
    case "TELEGRAM_CAPABILITY_NOT_AVAILABLE":
      return "This command is not available yet.";
    case "ADMIN_TELEGRAM_OWNER_REQUIRED":
    case "ADMIN_ROLE_REQUIRED":
      return null; // never confirm the admin control plane exists to anyone else
    default:
      break;
  }
  if (typeof result.body.message === "string") return result.body.message;
  if (result.status >= 400) return `Something went wrong${code ? ` (${code})` : ""}. Please try again later.`;
  const payload = result.body.result;
  if (payload === undefined) return `✅ ${command} done.`;
  return `✅ ${command}\n${JSON.stringify(payload, null, 2)}`.slice(0, 3900);
}

export function createGatewayDispatcher(deps: GatewayDispatcherDeps) {
  async function handleLinkCommand(input: {
    botKey: string; botName: string; command: string; args: string[];
    chatId: string; telegramUserId: string; username: string | null;
  }): Promise<GatewayResult | null> {
    const { botKey, botName, command, args, chatId, telegramUserId, username } = input;

    if (command === "/start" && args[0] && LINK_CODE_SHAPE.test(args[0])) {
      const result = await deps.links.claimWebCodeFromBot({ botKey, code: args[0], chatId, telegramUserId, username });
      if (result.ok) {
        await deps.sendReply(botKey, chatId, `✅ Linked! This chat is now connected to your AYZEN account for ${botName}. Send /help to see what you can do.`);
        return { status: 200, body: { accepted: true, botKey, linked: true } };
      }
      const text =
        result.code === "CHAT_ALREADY_LINKED" ? `This chat is already linked to another AYZEN account. Send /disconnect first, then try again.`
        : result.code === "TOO_MANY_ATTEMPTS" ? "Too many invalid codes. Wait a few minutes and request a new code in AYZEN."
        : "That code is invalid or expired. Request a new one in AYZEN → Settings → Telegram.";
      await deps.sendReply(botKey, chatId, text);
      return { status: 200, body: { accepted: false, code: result.code, botKey } };
    }

    if (command === "/connect") {
      const { code, expiresAt } = await deps.links.startBotLink({ botKey, chatId, telegramUserId, username });
      const minutes = Math.round((expiresAt.getTime() - Date.now()) / 60000);
      await deps.sendReply(botKey, chatId, `🔗 Your one-time code: ${formatLinkCode(code)}\n\nEnter it in AYZEN → ${botName} → Settings → Telegram → "I have a code".\nExpires in ~${Math.max(minutes, 1)} minutes.`);
      return { status: 200, body: { accepted: true, botKey, codeIssued: true } };
    }

    if (command === "/disconnect") {
      const removed = await deps.links.unlinkChat(botKey, chatId);
      await deps.sendReply(botKey, chatId, removed ? `✅ This chat is disconnected from ${botName}.` : "No linked account found for this chat.");
      return { status: 200, body: { accepted: true, botKey, unlinked: removed } };
    }
    return null;
  }

  return {
    async dispatch(input: { botKey: string; payload: unknown; requestId?: string }): Promise<GatewayResult> {
      const { botKey, payload } = input;
      const descriptor = getTelegramBotDescriptor(botKey);
      const updateId = (payload as { update_id?: unknown } | null)?.update_id;
      if (!descriptor || typeof payload !== "object" || payload === null || !Number.isSafeInteger(updateId) || (updateId as number) < 0) {
        return { status: 400, body: { error: "Unknown bot or invalid Telegram update", code: "INVALID_TELEGRAM_UPDATE" } };
      }
      const envelope: TelegramUpdateEnvelope = { updateId: updateId as number, botKey, receivedAt: new Date(), payload };

      if (!(await deps.claim(envelope))) return { status: 200, body: { accepted: true, duplicate: true } };

      const adapter = deps.adapters[botKey];
      if (!adapter) {
        await deps.mark(envelope, "failed", "No domain adapter registered");
        return { status: 503, body: { accepted: false, status: "not_available", code: "TELEGRAM_DOMAIN_ADAPTER_NOT_AVAILABLE", botKey } };
      }

      await deps.mark(envelope, "processing");
      try {
        const message = normalizeTelegramMessage({ botKey, updateId: envelope.updateId, payload });
        const text = message?.text ?? "";
        const [rawCommand, ...args] = text.trim().split(/\s+/);
        // "/start@MyBot" is how Telegram addresses a bot in groups.
        const command = String(rawCommand ?? "").toLowerCase().replace(/@[a-z0-9_]+$/, "");
        const chatId = message?.chatId !== undefined ? String(message.chatId) : undefined;
        const telegramUserId = message ? String(message.telegramUserId) : undefined;
        const privateChat = chatId !== undefined && chatId === telegramUserId;

        // Account-link commands: private chats only, and the admin bot only for its verified owner.
        if (message && chatId && telegramUserId && privateChat && ["/start", "/connect", "/disconnect"].includes(command)) {
          const isAdminBot = botKey === "admin";
          const owner = deps.adminOwnerId();
          if (isAdminBot && (!owner || owner !== telegramUserId)) {
            await deps.mark(envelope, "failed", "ADMIN_TELEGRAM_OWNER_REQUIRED");
            return { status: 403, body: { accepted: false, code: "ADMIN_TELEGRAM_OWNER_REQUIRED", botKey } };
          }
          const linked = await handleLinkCommand({ botKey, botName: descriptor.displayName, command, args, chatId, telegramUserId, username: message.username ?? null });
          if (linked) {
            if (linked.body.accepted === false) await deps.mark(envelope, "failed", String(linked.body.code ?? "LINK_FAILED").slice(0, 120));
            else await deps.mark(envelope, "completed");
            return { status: 200, body: linked.body };
          }
        }

        const result = await adapter.handle({
          envelope, message, command, args, botKey,
          requestId: input.requestId ?? crypto.randomUUID(),
          getFailures: deps.getFailures,
        });
        // Persist only a code, never the body: it can carry upstream data / secrets.
        if (result.status >= 400) await deps.mark(envelope, "failed", String(result.body.code ?? `HTTP_${result.status}`).slice(0, 120));
        else await deps.mark(envelope, "completed");

        let replied = false;
        const replyText = friendlyReply(descriptor.displayName, result, command);
        if (replyText && chatId) replied = await deps.sendReply(botKey, chatId, replyText);
        // Telegram retries non-2xx webhook deliveries; once the user has been told, acknowledge.
        return replied && result.status >= 400 && result.status < 500 ? { status: 200, body: result.body } : result;
      } catch (error) {
        await deps.mark(envelope, "failed", (error instanceof Error ? error.message : String(error)).slice(0, 200));
        return { status: 502, body: { accepted: false, code: "TELEGRAM_DOMAIN_DISPATCH_FAILED", botKey } };
      }
    },
  };
}

export type GatewayDispatcher = ReturnType<typeof createGatewayDispatcher>;
