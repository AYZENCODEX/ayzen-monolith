// projects/security/receipt-token.ts
// Public project P&L receipt links: possession of the token is the authorization (same model as the Vault and
// Finance receipt tokens). Moved unchanged from routes/projects.ts (PRJ-04); mirrors vault/security/receipt-token.ts.
import crypto from "crypto";
import { getAppUrl } from "../../lib/app-url";

export function generateProjectReceiptToken(): string {
  return crypto.randomBytes(20).toString("base64url");
}

export function projectReceiptUrl(receiptToken: string): string {
  return `${getAppUrl()}/receipt/project/${receiptToken}`;
}
