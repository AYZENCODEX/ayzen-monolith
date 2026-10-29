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
