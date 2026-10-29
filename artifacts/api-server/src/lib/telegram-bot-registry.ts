import type { DomainService } from "./architecture/domains";

export type TelegramBotKey = "ayzenx" | "warde" | "verve" | "ryft" | "sylo" | "skarn" | "zynth" | "wisp" | "admin";

export interface TelegramBotDescriptor {
  key: TelegramBotKey;
  displayName: string;
  responsibility: string;
  service: DomainService | "admin";
  tokenEnvVar: string;
  webhookSecretEnvVar: string;
}

export const TELEGRAM_BOT_REGISTRY: readonly TelegramBotDescriptor[] = [
  { key: "ayzenx", displayName: "AYZENX", responsibility: "Personal workspace", service: "workspace", tokenEnvVar: "TELEGRAM_BOT_TOKEN", webhookSecretEnvVar: "TELEGRAM_WEBHOOK_SECRET" },
  { key: "warde", displayName: "WARDE", responsibility: "Organization / business workspace", service: "workspace", tokenEnvVar: "TELEGRAM_WARDE_BOT_TOKEN", webhookSecretEnvVar: "TELEGRAM_WARDE_WEBHOOK_SECRET" },
  { key: "verve", displayName: "VERVE", responsibility: "Communication / productivity", service: "mail", tokenEnvVar: "TELEGRAM_VERVE_BOT_TOKEN", webhookSecretEnvVar: "TELEGRAM_VERVE_WEBHOOK_SECRET" },
  { key: "ryft", displayName: "RYFT", responsibility: "Finance", service: "finance", tokenEnvVar: "TELEGRAM_RYFT_BOT_TOKEN", webhookSecretEnvVar: "TELEGRAM_RYFT_WEBHOOK_SECRET" },
  { key: "sylo", displayName: "SYLO", responsibility: "Secure storage / vault", service: "vault", tokenEnvVar: "TELEGRAM_SYLO_BOT_TOKEN", webhookSecretEnvVar: "TELEGRAM_SYLO_WEBHOOK_SECRET" },
  { key: "skarn", displayName: "SKARN", responsibility: "Automation / workflow", service: "workflow", tokenEnvVar: "TELEGRAM_SKARN_BOT_TOKEN", webhookSecretEnvVar: "TELEGRAM_SKARN_WEBHOOK_SECRET" },
  { key: "zynth", displayName: "ZYNTH", responsibility: "AI / intelligence / agent", service: "ai-agent", tokenEnvVar: "TELEGRAM_ZYNTH_BOT_TOKEN", webhookSecretEnvVar: "TELEGRAM_ZYNTH_WEBHOOK_SECRET" },
  { key: "wisp", displayName: "WISP", responsibility: "Mailbox / email", service: "mail", tokenEnvVar: "TELEGRAM_WISP_BOT_TOKEN", webhookSecretEnvVar: "TELEGRAM_WISP_WEBHOOK_SECRET" },
  { key: "admin", displayName: "AYZEN Admin", responsibility: "Privileged control plane", service: "admin", tokenEnvVar: "TELEGRAM_ADMIN_BOT_TOKEN", webhookSecretEnvVar: "TELEGRAM_ADMIN_WEBHOOK_SECRET" },
];

export function getTelegramBotDescriptor(key: string): TelegramBotDescriptor | undefined {
  return TELEGRAM_BOT_REGISTRY.find((bot) => bot.key === key);
}

export function getTelegramBotStatus(): Array<TelegramBotDescriptor & { configured: boolean }> {
  return TELEGRAM_BOT_REGISTRY.map((bot) => ({ ...bot, configured: Boolean(process.env[bot.tokenEnvVar]) }));
}