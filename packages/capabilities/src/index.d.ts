export interface CapabilityDefinition {
  capability: string;
  bot: string;
  method: string;
  route: string;
  status: string;
  permission: string;
  event: string;
  sensitive: boolean;
}

export interface TelegramCommandDefinition {
  bot: string;
  command: string;
  capability: string;
  deprecated?: boolean;
  replacement?: string;
}

export const CAPABILITY_REGISTRY: readonly CapabilityDefinition[];
export function getCapability(capability: string): CapabilityDefinition | undefined;
export function listTelegramCommands(options?: { bot?: string }): readonly TelegramCommandDefinition[];