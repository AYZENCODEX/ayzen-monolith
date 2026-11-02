/** Wires the gateway dispatcher to the real DB, adapters and Telegram API. */
import { logger } from "./logger";
import { claimTelegramUpdate, listFailedTelegramUpdates, markTelegramUpdate } from "./telegram-gateway";
import { getTelegramBotDescriptor } from "./telegram-bot-registry";
import { sendMessage } from "./telegram-api";
import { createGatewayDispatcher } from "./telegram-gateway-dispatch";
import { TELEGRAM_ADAPTERS } from "./telegram-adapters";
import { telegramLinks } from "./telegram-link-service";

export { telegramLinks };

export async function sendBotMessage(botKey: string, chatId: string, text: string): Promise<boolean> {
  const descriptor = getTelegramBotDescriptor(botKey);
  const token = descriptor ? process.env[descriptor.tokenEnvVar] : undefined;
  if (!token) return false;
  try {
    await sendMessage(token, chatId, text);
    return true;
  } catch (err) {
    // The error never contains the token (see telegram-api.ts).
    logger.warn({ botKey, err: err instanceof Error ? err.message : String(err) }, "Telegram reply failed");
    return false;
  }
}

export const gatewayDispatcher = createGatewayDispatcher({
  claim: claimTelegramUpdate,
  mark: markTelegramUpdate,
  links: telegramLinks,
  adapters: TELEGRAM_ADAPTERS,
  sendReply: sendBotMessage,
  getFailures: async () => listFailedTelegramUpdates(),
  adminOwnerId: () => process.env.TELEGRAM_ADMIN_OWNER_ID,
});
