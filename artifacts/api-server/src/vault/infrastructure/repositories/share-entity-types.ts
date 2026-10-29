import { VAULT_ENTITY_ENCRYPTED_FIELDS } from "../../domain/secret-fields";

/** Extracted verbatim from the pre-extraction route (VLT-GAP-10); bodies unchanged. */

/**
 * Vault entity sharing ("transfer" in the product sense the team uses the
 * word — access moves, ownership never does).
 *
 * Sharing an entity does NOT change which user owns it — the owner_id
 * column here is separate from, and never writes to, the user_id column on
 * the underlying local_accounts / vault_entries / kyc_entries / game_entries
 * row. A share is just a grant of read (or edit) access to another user.
 * Turning is_active off (PATCH) — or deleting the row (DELETE) — instantly
 * removes that access; the entity itself, and who owns it, is untouched.
 */

// entity_type -> underlying table + a short label column used to render a
// human-readable name for the shared item without exposing sensitive fields.
// Exported for routes/organizations.ts (Phase 8 — org-wide vault sharing):
// same entity_type -> table/sensitive-fields/label mapping, reused rather
// than duplicated so a future encrypted column never has to be added here
// AND kept in sync in two files (exactly the drift bug this file's own
// Phase C23-era comment above the individual entries describes fixing).
export const ENTITY_TABLES: Record<string, { table: string; sensitive: readonly string[]; label: (row: any) => string; deletedAtCol?: string }> = {
  local: {
    table: "local_accounts",
    sensitive: ["password", "recovery_email_password", "backup_codes", "twofa", "recovery_email_twofa"],
    label: (r) => r.label || r.username || r.email || `Local #${r.id}`,
  },
  entity: {
    table: "vault_entries",
    // Kept in sync with formatRow() in routes/vault.ts via a shared export —
    // see VAULT_ENTITY_ENCRYPTED_FIELDS there. Previously this was a
    // hand-maintained duplicate list that had drifted out of sync (missing
    // 17 of the 35 encrypted columns — every *_2fa / *_backup_code field
    // added after the initial share-feature build never got added here),
    // so a shared/owner-via-this-route view of an entity returned raw
    // ciphertext instead of the decrypted 2FA/backup codes for those fields.
    sensitive: VAULT_ENTITY_ENCRYPTED_FIELDS,
    label: (r) => r.project_name || r.username || `Entity #${r.id}`,
    // Only vault_entries has a recycle bin today — see routes/vault.ts. A
    // trashed entity must behave, for sharing purposes, exactly like a
    // fully-deleted local/kyc/game row already does: no new shares, and any
    // existing share stops resolving ("Entity no longer exists") instead of
    // still handing out decrypted fields for something the owner threw away.
    deletedAtCol: "deleted_at",
  },
  kyc: {
    table: "kyc_entries",
    sensitive: ["account_password", "email_password", "email_2fa", "email_backup_code", "nid_number"],
    label: (r) => r.name || r.username || `KYC #${r.id}`,
  },
  game: {
    table: "game_entries",
    sensitive: ["account_password", "email_password", "email_2fa", "email_backup_code"],
    label: (r) => r.username || `Game #${r.id}`,
  },
};
// Appended to a raw WHERE clause to exclude soft-deleted rows for entity
// types that have a recycle bin (currently just "entity" — see above).
// Empty string for every other type, so this is safe to splice in everywhere.
export function notTrashedClause(cfg: { deletedAtCol?: string }): string {
  return cfg.deletedAtCol ? ` AND ${cfg.deletedAtCol} IS NULL` : "";
}
export const VALID_TYPES = Object.keys(ENTITY_TABLES);
// Internal/owner-only columns that can never be part of a per-field share —
// they either identify the row itself or its true owner, neither of which a
// share should ever expose or let a recipient edit.
export const NON_SHAREABLE_COLUMNS = new Set(["id", "user_id", "created_at", "updated_at", "entity_serial"]);
export const safe = (v: unknown) => v === null || v === undefined || v === "" ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;
export const ENTITY_TYPE_TO_RESOURCE_TYPE: Record<keyof typeof ENTITY_TABLES, string> = {
  local: "local_account",
  entity: "vault_entry",
  kyc: "kyc_entry",
  game: "game_entry",
};
export function isValidType(t: unknown): t is keyof typeof ENTITY_TABLES {
  return typeof t === "string" && VALID_TYPES.includes(t);
}
export type FieldPermission = "view" | "edit";
export type FieldPermissionMap = Record<string, FieldPermission>;