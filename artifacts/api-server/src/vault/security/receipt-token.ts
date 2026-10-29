import crypto from "crypto";

/**
 * VLT-GAP-16-B: public-receipt token + link builder shared by the Vault entity receipt and the two local-account
 * receipts (single account, category). They each carried an identical 20-byte base64url generator and the same
 * `${APP_URL}/receipt/<kind>/<token>` builder; only the path segment differed. Same possession-is-auth model as
 * finance_ledger_entries.receipt_token.
 */
export type VaultReceiptKind = "entity" | "local" | "vault-category";

export function generateVaultReceiptToken(): string {
  return crypto.randomBytes(20).toString("base64url");
}

export function vaultReceiptLink(kind: VaultReceiptKind, receiptToken: string): string {
  return `${process.env.APP_URL ?? "https://ayzen.replit.app"}/receipt/${kind}/${receiptToken}`;
}
