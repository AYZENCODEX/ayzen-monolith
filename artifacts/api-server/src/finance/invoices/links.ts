import crypto from "crypto";
import QRCode from "qrcode";
import { getAppUrl } from "../../lib/app-url";

// Invoice and payment-agreement tokens, the public URLs they live at, and the scan-to-pay QR for the
// invoice link. Moved unchanged from lib/finance-invoice.ts (FIN-WP-6a).

export function generateInvoiceToken(): string {
  return crypto.randomBytes(20).toString("base64url");
}

export function generateAgreementToken(): string {
  return crypto.randomBytes(20).toString("base64url");
}

export function financeInvoiceUrl(token: string): string {
  return `${getAppUrl()}/finance/invoice/${token}`;
}

export function financePaymentAgreementUrl(token: string): string {
  return `${getAppUrl()}/finance/payment-agreement/${token}`;
}

/** Renders a scan-to-pay QR for the public invoice link itself (distinct from the per-payment-method QR in generatePaymentQrDataUrl). Never throws. */
export async function generateInvoicePayLinkQrDataUrl(url: string): Promise<string | null> {
  try {
    return await QRCode.toDataURL(url, { margin: 1, width: 240 });
  } catch {
    return null;
  }
}
