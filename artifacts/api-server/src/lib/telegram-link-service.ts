import { createTelegramLinkService } from "./telegram-bot-links";
import { drizzleTelegramLinkStore } from "./telegram-bot-links-store";

/** Process-wide link service backed by Postgres. */
export const telegramLinks = createTelegramLinkService({ store: drizzleTelegramLinkStore });
