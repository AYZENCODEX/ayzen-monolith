export const VAULT_ENTRY_OWNER_SENTINEL_NONE = -1;
export const VAULT_ENTITY_LINK_OWNER_SENTINEL_NONE = -1;

export const RELATION_TYPES = [
  "alt_of",
  "main_of",
  "shares_wallet",
  "shares_email",
  "shares_ip",
  "shares_device",
  "same_owner",
  "other",
] as const;

export type RelationType = (typeof RELATION_TYPES)[number];

export function isRelationType(value: unknown): value is RelationType {
  return typeof value === "string" && (RELATION_TYPES as readonly string[]).includes(value);
}

export const INVERSE_RELATION: Record<RelationType, RelationType> = {
  alt_of: "main_of",
  main_of: "alt_of",
  shares_wallet: "shares_wallet",
  shares_email: "shares_email",
  shares_ip: "shares_ip",
  shares_device: "shares_device",
  same_owner: "same_owner",
  other: "other",
};

export function labelFor(entity: Record<string, unknown> | undefined | null): string {
  if (!entity) return "Unknown entity";
  return (entity.projectName as string) || (entity.username as string) || `Entity #${entity.id}`;
}

/** Structural view of the request: only the route params are read (an Express Request satisfies it). */
export interface VaultEntryRouteRequest { params: Record<string, string | string[] | undefined> }

export function invalidVaultEntryResource(req: VaultEntryRouteRequest): { type: string; id: unknown; ownerId: number } {
  return {
    type: "vault_entry",
    id: Array.isArray(req.params.id) ? req.params.id[0] : req.params.id,
    ownerId: VAULT_ENTRY_OWNER_SENTINEL_NONE,
  };
}

