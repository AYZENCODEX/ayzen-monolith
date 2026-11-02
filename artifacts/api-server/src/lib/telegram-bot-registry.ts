import { BOT_REGISTRY } from "@ayzen/telegram";
import type { DomainService } from "./architecture/domains";

export type TelegramBotKey = "ayzenx" | "warde" | "verve" | "ryft" | "fyra" | "sylo" | "skarn" | "zynth" | "wisp" | "admin";

export interface TelegramBotDescriptor {
  key: TelegramBotKey;
  displayName: string;
  responsibility: string;
  service: DomainService | "admin";
  tokenEnvVar: string;
  webhookSecretEnvVar: string;
}

/**
 * Derived from `BOT_REGISTRY` in packages/telegram — the single source of truth
 * for bot keys, token env names and webhook-secret env names. Do not add bots
 * here; add them there (and a drift test guards the key list below).
 */
export const TELEGRAM_BOT_REGISTRY: readonly TelegramBotDescriptor[] = Object.entries(BOT_REGISTRY).map(([key, bot]) => ({
  key: key as TelegramBotKey,
  displayName: bot.displayName,
  responsibility: bot.responsibility,
  service: bot.service as DomainService | "admin",
  tokenEnvVar: bot.tokenEnv,
  webhookSecretEnvVar: bot.secretEnv,
}));

export function getTelegramBotDescriptor(key: string): TelegramBotDescriptor | undefined {
  return TELEGRAM_BOT_REGISTRY.find((bot) => bot.key === key);
}

export function getTelegramBotStatus(): Array<TelegramBotDescriptor & { configured: boolean }> {
  return TELEGRAM_BOT_REGISTRY.map((bot) => ({ ...bot, configured: Boolean(process.env[bot.tokenEnvVar]) }));
}
