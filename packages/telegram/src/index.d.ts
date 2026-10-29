export interface NormalizedTelegramMessage {
  botKey: string;
  updateId: number;
  telegramUserId: number;
  username?: string;
  chatId?: number;
  text: string;
  command?: string;
  capability?: string;
  callbackData?: string;
}

export function normalizeTelegramMessage(envelope: unknown): NormalizedTelegramMessage | null;
export function renderCommandTreeHelp(botKey: string): string | undefined;
export function renderSubcommandHelp(botKey: string, command: string): string;
export function resolveCommandTreePath(input: string, options: { botKey: string }): {
  capability?: string;
  bot?: string;
  command?: string;
  args: string[];
  path: string[];
  hasSubcommands?: boolean;
  deprecated?: boolean;
  replacement?: string;
} | null;