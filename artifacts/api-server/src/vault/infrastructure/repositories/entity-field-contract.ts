import type { vaultEntriesTable } from "@workspace/db";
import type { NEW_VAULT_FIELDS } from "../../domain/entity/fields";

/**
 * VLT-GAP-14-B: the domain allow-list (domain/entity/fields.ts) no longer
 * imports the DB schema, so the compile-time guarantee that every listed field
 * is a real vault_entries column lives here, in infrastructure. Type-only: if a
 * listed field is not an insertable column this file stops compiling.
 */
type VaultEntryInsertKey = keyof typeof vaultEntriesTable.$inferInsert;
type UnknownNewVaultFields = Exclude<(typeof NEW_VAULT_FIELDS)[number], VaultEntryInsertKey>;
export type NewVaultFieldsMatchSchema = [UnknownNewVaultFields] extends [never] ? true : never;
export const NEW_VAULT_FIELDS_MATCH_SCHEMA: NewVaultFieldsMatchSchema = true;
