import crypto from "crypto";
import QRCode from "qrcode";

// Invoice and payment-agreement tokens, the public URLs they live at, and the scan-to-pay QR for the
// invoice link. Moved unchanged from lib/finance-invoice.ts (FIN-WP-6a).

export function generateInvoiceToken(): string {
  return crypto.randomBytes(20).toString("base64url");
}

export function generateAgreementToken(): string {
  return crypto.randomBytes(20).toString("base64url");
}

function appUrl(): string {
  return process.env.APP_URL ?? "https://ayzen.replit.app";
}

export function financeInvoiceUrl(token: string): string {
  return `${appUrl()}/finance/invoice/${token}`;
}

export function financePaymentAgreementUrl(token: string): string {
  return `${appUrl()}/finance/payment-agreement/${token}`;
}

/** Renders a scan-to-pay QR for the public invoice link itself (distinct from the per-payment-method QR in generatePaymentQrDataUrl). Never throws. */
export async function generateInvoicePayLinkQrDataUrl(url: string): Promise<string | null> {
  try {
    return await QRCode.toDataURL(url, { margin: 1, width: 240 });
  } catch {
    return null;
  }
}
