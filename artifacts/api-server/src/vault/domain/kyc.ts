export const KYC_SENSITIVE_FIELDS = [
  "account_password",
  "email_password",
  "email_2fa",
  "email_backup_code",
  "nid_number",
  "account_2fa",
  "account_backup_code",
  "email_recovery_password",
  "recovery_2fa",
  "recovery_backup_code",
] as const;

export const KYC_ENTRY_OWNER_SENTINEL_NONE = -1;

export function isKycStatus(value: unknown): value is "active" | "inactive" | "suspended" {
  return value === "active" || value === "inactive" || value === "suspended";
}

// ── VLT-GAP-03-B additions (existing content above is untouched) ─────────────
// Status vocabulary accepted by PATCH /kyc-entries/:id/status. Pre-existing
// behavior, preserved as-is: it does NOT match `isKycStatus` above (which is
// still unused) — only ban / unban is allowed here.
export const KYC_ENTRY_BAN_STATUSES = ["active", "banned"];

export function isKycBanStatus(value: unknown, allowed: readonly unknown[] = KYC_ENTRY_BAN_STATUSES): boolean {
  return allowed.includes(value);
}

// Only the NID number is a secret-grade field on a data entity — name/father's
// name/birthdate/photos are identity data, not credentials, but nid_number is
// treated the same as it was on kyc_entries pre-split.
export const KYC_DATA_ENTITY_SENSITIVE_FIELDS = ["nid_number"] as const;

export const KYC_DATA_ENTITY_OWNER_SENTINEL_NONE = -1;
