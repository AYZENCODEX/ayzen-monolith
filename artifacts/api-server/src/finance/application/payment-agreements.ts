import type { Response } from "express";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  financeInvoicesTable,
  financePaymentAgreementsTable,
  financeLedgerEntriesTable,
  financeRepaymentsTable,
  passkeyCredentialsTable,
  usersTable,
} from "@workspace/db";
import { generateAuthenticationOptions, verifyAuthenticationResponse } from "@simplewebauthn/server";
import { applyPrincipalRepaymentTx } from "../ledger/repayments";
import { postRepaymentJournal, REPAYABLE_KINDS } from "../ledger/journal";
import { PAYMENT_METHOD_LABELS } from "../payment-methods/payment-methods";
import { financeInvoiceUrl } from "../invoices/links";
import { logInvoiceEvent, getClientIpLocal, type InvoiceEventRequest } from "../invoices/events";
import { iso, money } from "../invoices/format";
import { newChallengeKey, storeChallenge } from "../../lib/passkey";
import { sendPaymentAgreementReadyEmail, sendPaymentDisputedEmail } from "../../lib/email";
import { sendToUser } from "../../lib/telegram";
import { createNotification } from "../../lib/create-notification";
import { streamFantasticReceiptPdf } from "../../lib/receipt-theme";

// Payment-agreement use cases: the public agreement page, the payer's passkey confirmation (options and verify),
// the evidence PDF, and the creditor's verify and dispute. Moved from routes/finance-invoices.ts (FIN-WP-6b).
// The route keeps authentication, id and body-shape validation, every PDP ownership check and its ordering, the
// WebAuthn config taken from the request, the consumption of the in-memory challenge and response formatting.
// Messages and status mapping are the ones the routes returned.
//
// Logic changes, all recorded in finance-safety-findings.md and covered by wp6b-use-cases.db.test.ts:
//  - F19 passkey confirmation could overwrite a dispute: the agreement was written back as "passkey_confirmed"
//    with no status condition, so a dispute that landed after the status read was undone and the creditor could
//    then verify a claim they had just rejected. The write is now conditional on status "submitted".
//  - F20 dispute was two unlocked statements built on a stale status read: a verify that committed in between
//    was overwritten ("disputed" on top of a posted repayment), and the invoice was marked disputed even when it
//    was already settled. It is now one transaction under the invoice row lock, the agreement is claimed
//    conditionally, and a settled or cancelled invoice keeps its status.
//  - F21 (the first open item of F18) verify did not check that the claim still fits the remaining balance, so two
//    claims for the full amount could both be verified and push paidAmount above the invoice amount. Verify now
//    locks the invoice first and refuses a claim that exceeds what is still owed. Submit is unchanged.
// Best-effort notifications and evidence events stay fire-and-forget after the commit, as before.

type AgreementRow = typeof financePaymentAgreementsTable.$inferSelect;
type InvoiceRow = typeof financeInvoicesTable.$inferSelect;

const appUrl = () => process.env.APP_URL ?? "https://ayzen.replit.app";

// ─── Lookups used by the route before its PDP checks ─────────────────────────

export async function findAgreementByToken(token: string): Promise<AgreementRow | undefined> {
  const [agreement] = await db.select().from(financePaymentAgreementsTable)
    .where(eq(financePaymentAgreementsTable.agreementToken, token));
  return agreement;
}

/** The agreement and the real owner of the invoice it points at (the creditor), for the route's ownership check. */
export async function findAgreementInvoiceOwner(agreementId: number): Promise<{ agreement: AgreementRow; invoiceId: number; ownerId: number | undefined } | null> {
  const [agreement] = await db.select().from(financePaymentAgreementsTable).where(eq(financePaymentAgreementsTable.id, agreementId));
  if (!agreement) return null;
  const [row] = await db.select({ userId: financeInvoicesTable.userId }).from(financeInvoicesTable)
    .where(eq(financeInvoicesTable.id, agreement.invoiceId)).limit(1);
  return { agreement, invoiceId: agreement.invoiceId, ownerId: row?.userId };
}

// ─── Public agreement page ───────────────────────────────────────────────────

export async function getPublicAgreementView(token: string) {
  const agreement = await findAgreementByToken(token);
  if (!agreement) return null;

  const [invoice] = await db.select().from(financeInvoicesTable).where(eq(financeInvoicesTable.id, agreement.invoiceId));
  const [creditor] = invoice ? await db.select({ username: usersTable.username }).from(usersTable).where(eq(usersTable.id, invoice.userId)) : [null];

  return {
    id: agreement.id,
    status: agreement.status,
    methodType: agreement.methodType,
    referenceId: agreement.referenceId,
    amount: agreement.amount,
    submittedAt: iso(agreement.submittedAt),
    confirmedAt: iso(agreement.confirmedAt),
    creditorVerifiedAt: iso(agreement.creditorVerifiedAt),
    disputedAt: iso(agreement.disputedAt),
    disputeReason: agreement.disputeReason,
    invoiceTitle: invoice ? `Invoice #${invoice.id}` : null,
    currency: invoice?.currency ?? "BDT",
    creditorName: creditor?.username ?? null,
    debtorName: invoice?.debtorName ?? null,
    evidenceAvailable: agreement.status === "passkey_confirmed" || agreement.status === "creditor_verified",
  };
}

// ─── Passkey confirmation ────────────────────────────────────────────────────

export type PasskeyOptionsResult =
  | { status: "ok"; options: Awaited<ReturnType<typeof generateAuthenticationOptions>>; challengeKey: string }
  | { status: "no_passkey" };

/** Builds the WebAuthn authentication options for the payer's own registered passkeys and stores the challenge. */
export async function createPasskeyOptions(userId: number, rpID: string): Promise<PasskeyOptionsResult> {
  const creds = await db.select().from(passkeyCredentialsTable).where(eq(passkeyCredentialsTable.userId, userId));
  if (creds.length === 0) return { status: "no_passkey" };

  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: creds.map((c) => ({ id: c.credentialId, transports: c.transports ? (c.transports.split(",") as any[]) : undefined })),
    userVerification: "preferred",
  });

  const challengeKey = newChallengeKey();
  storeChallenge(challengeKey, options.challenge, userId);
  return { status: "ok", options, challengeKey };
}

export type ConfirmAgreementResult =
  | { status: "ok"; agreement: AgreementRow }
  | { status: "not_registered" }
  | { status: "failed"; message: string }
  | { status: "not_submitted"; current: string };

type AuthenticationVerifier = (args: any) => Promise<{ verified: boolean; authenticationInfo: { newCounter: number } }>;

/**
 * Verifies the payer's passkey assertion and marks the agreement passkey_confirmed. The caller has already checked
 * that the agreement is the payer's, that it was "submitted", and has consumed the challenge. `deps.verifyAuthentication`
 * is the WebAuthn check (real by default); tests replace it because a real assertion needs a hardware key.
 */
export async function confirmAgreementWithPasskey(
  userId: number,
  agreement: AgreementRow,
  input: { challenge: string; response: any; rpID: string; origin: string },
  req: InvoiceEventRequest,
  deps: { verifyAuthentication?: AuthenticationVerifier } = {},
): Promise<ConfirmAgreementResult> {
  const verifyAuthentication: AuthenticationVerifier = deps.verifyAuthentication ?? (verifyAuthenticationResponse as unknown as AuthenticationVerifier);
  const credentialId: string = input.response.id;
  const [cred] = await db.select().from(passkeyCredentialsTable)
    .where(and(eq(passkeyCredentialsTable.credentialId, credentialId), eq(passkeyCredentialsTable.userId, userId)));
  if (!cred) return { status: "not_registered" };

  // Only the WebAuthn check is turned into a 401. A database failure below is a real error and surfaces as a 500.
  let newCounter: number;
  try {
    const verification = await verifyAuthentication({
      response: input.response,
      expectedChallenge: input.challenge,
      expectedOrigin: input.origin,
      expectedRPID: input.rpID,
      credential: {
        id: cred.credentialId,
        publicKey: new Uint8Array(Buffer.from(cred.publicKey, "base64url")),
        counter: cred.counter,
        transports: cred.transports ? (cred.transports.split(",") as any[]) : undefined,
      },
    });
    if (!verification.verified) return { status: "failed", message: "Passkey verification failed" };
    newCounter = verification.authenticationInfo.newCounter;
  } catch (err: any) {
    return { status: "failed", message: err?.message || "Passkey verification failed" };
  }

  const ip = getClientIpLocal(req);
  const userAgent = (req.headers["user-agent"] as string) || null;

  // F19: the counter update and the agreement flip commit together, and the flip only applies while the agreement
  // is still "submitted". A dispute (or anything else) that landed first wins and the confirmation is refused. The
  // assertion was valid and has been used, so the counter is advanced either way.
  const outcome = await db.transaction(async (tx) => {
    await tx.update(passkeyCredentialsTable)
      .set({ counter: newCounter, lastUsedAt: new Date() })
      .where(eq(passkeyCredentialsTable.id, cred.id));

    const [updated] = await tx.update(financePaymentAgreementsTable).set({
      status: "passkey_confirmed", confirmedAt: new Date(), passkeyCredentialId: cred.id,
      ipAddress: ip, userAgent, updatedAt: new Date(),
    }).where(and(eq(financePaymentAgreementsTable.id, agreement.id), eq(financePaymentAgreementsTable.status, "submitted"))).returning();
    if (updated) return { updated, current: updated.status };

    const [now] = await tx.select({ status: financePaymentAgreementsTable.status }).from(financePaymentAgreementsTable)
      .where(eq(financePaymentAgreementsTable.id, agreement.id));
    return { updated: null, current: now?.status ?? "unknown" };
  });
  if (!outcome.updated) return { status: "not_submitted", current: outcome.current };
  const updated = outcome.updated;

  logInvoiceEvent(agreement.invoiceId, "agreement_confirmed", req, { agreementId: agreement.id, passkeyCredentialId: cred.id }).catch(() => {});

  // Tell the creditor it's ready to verify.
  const [invoice] = await db.select().from(financeInvoicesTable).where(eq(financeInvoicesTable.id, agreement.invoiceId));
  if (invoice) {
    const [payer] = await db.select({ username: usersTable.username }).from(usersTable).where(eq(usersTable.id, userId));
    const [creditor] = await db.select({ username: usersTable.username, email: usersTable.email, telegramChatId: usersTable.telegramChatId })
      .from(usersTable).where(eq(usersTable.id, invoice.userId));
    const payerName = payer?.username ?? invoice.debtorName;
    createNotification(invoice.userId, "finance_payment_confirmed", "Payment confirmed with passkey",
      `${payerName} signed a Payment Agreement for ${money(invoice.currency, updated.amount)}. Review and verify to mark it repaid.`,
      { invoiceId: invoice.id, agreementId: agreement.id }).catch(() => {});
    const reviewUrl = `${appUrl()}/finance/invoices`;
    if (creditor?.email) {
      sendPaymentAgreementReadyEmail(creditor.email, {
        creditorName: creditor.username ?? "there", debtorName: payerName, title: `Invoice #${invoice.id}`,
        amount: money(invoice.currency, updated.amount), url: reviewUrl,
      }).catch(() => {});
    }
    if (creditor?.telegramChatId) {
      sendToUser(creditor.telegramChatId, `🔏 *${payerName}* signed a Payment Agreement for *${money(invoice.currency, updated.amount)}* — review it in Finance → Invoices.`).catch(() => {});
    }
  }

  return { status: "ok", agreement: updated };
}

// ─── Evidence PDF ────────────────────────────────────────────────────────────

/** Streams the evidence PDF for a passkey-confirmed or verified agreement. False when the link or state is not valid. */
export async function streamAgreementEvidencePdf(res: Response, token: string): Promise<boolean> {
  const agreement = await findAgreementByToken(token);
  if (!agreement || (agreement.status !== "passkey_confirmed" && agreement.status !== "creditor_verified")) return false;

  const [invoice] = await db.select().from(financeInvoicesTable).where(eq(financeInvoicesTable.id, agreement.invoiceId));
  const [creditor] = invoice ? await db.select({ username: usersTable.username }).from(usersTable).where(eq(usersTable.id, invoice.userId)) : [null];
  const [payer] = agreement.payerUserId
    ? await db.select({ username: usersTable.username }).from(usersTable).where(eq(usersTable.id, agreement.payerUserId))
    : [null];

  streamFantasticReceiptPdf(res, {
    kicker: "Payment Agreement",
    title: `${payer?.username ?? invoice?.debtorName ?? "Payer"} → ${creditor?.username ?? "Creditor"}`,
    subtitle: invoice ? `Invoice #${invoice.id}` : undefined,
    avatarLetter: (payer?.username ?? invoice?.debtorName ?? "P").charAt(0).toUpperCase(),
    heroValue: money(invoice?.currency ?? "BDT", agreement.amount),
    heroLabel: "Amount Confirmed Paid",
    heroPositive: true,
    stats: [
      { label: "Method", value: PAYMENT_METHOD_LABELS[agreement.methodType] ?? agreement.methodType },
      { label: "Reference / Txn ID", value: agreement.referenceId ?? "—" },
      { label: "Submitted", value: agreement.submittedAt ? new Date(agreement.submittedAt).toLocaleString() : "—" },
      { label: "Passkey-confirmed", value: agreement.confirmedAt ? new Date(agreement.confirmedAt).toLocaleString() : "—" },
      { label: "IP address", value: agreement.ipAddress ?? "—" },
      { label: "Device", value: agreement.userAgent ?? "—" },
      { label: "Status", value: agreement.status === "creditor_verified" ? "Verified by creditor" : "Confirmed by payer (awaiting creditor review)" },
    ],
    notes: "Digitally signed by the payer using their AYZEN account passkey (WebAuthn). The IP address and device above were captured at the moment of signing as evidence of payment.",
    receiptId: agreement.id,
    issuedBy: creditor?.username ?? null,
    filenamePrefix: "payment-agreement",
  });
  return true;
}

// ─── Creditor review: verify ─────────────────────────────────────────────────

export type VerifyAgreementResult =
  | { status: "ok"; agreement: AgreementRow }
  | { status: "not_found" } // the agreement's invoice is missing or not the caller's
  | { status: "not_confirmed" } // 400: the payer has not passkey-confirmed it (or it is already settled)
  | { status: "already_verified" } // 409: a concurrent verify won
  | { status: "changed" } // 409: the agreement left "passkey_confirmed" (for example it was disputed) while this ran
  | { status: "exceeds_remaining"; currency: string; remaining: number }; // F21

/**
 * Creditor accepts a passkey-confirmed claim: the agreement is claimed, a real repayment is posted against the linked
 * ledger entry (when there is one and it is repayable) and the invoice's paid amount and status are updated, all in
 * one transaction under the invoice row lock. F21: the claim must still fit the remaining balance.
 */
export async function verifyPaymentAgreement(
  userId: number, agreementId: number, notes: string | undefined, req: InvoiceEventRequest,
): Promise<VerifyAgreementResult> {
  // Unlocked pre-checks keep the answers the route always gave; the transaction below re-decides under the lock.
  const [pre] = await db.select().from(financePaymentAgreementsTable).where(eq(financePaymentAgreementsTable.id, agreementId));
  if (!pre) return { status: "not_found" };
  const [preInvoice] = await db.select({ id: financeInvoicesTable.id }).from(financeInvoicesTable)
    .where(and(eq(financeInvoicesTable.id, pre.invoiceId), eq(financeInvoicesTable.userId, userId)));
  if (!preInvoice) return { status: "not_found" };
  if (pre.status !== "passkey_confirmed") return { status: "not_confirmed" };

  // Everything below is ONE transaction. The invoice row is locked first (the same order dispute and submit use), the
  // agreement is re-read under that lock and claimed with a conditional update (status must still be
  // passkey_confirmed), so two concurrent verify requests cannot both post a repayment and both count toward the
  // invoice. If any later step fails, the claim, the repayment, the entry balance and the invoice totals all roll
  // back together, so a retry cannot double-post.
  //
  // If the invoice is linked to a real ledger entry, an actual repayment is posted against it, the same accounting
  // path as POST /finance/entries/:id/repayments: `amount` tracks what is still outstanding and is reduced
  // atomically in SQL (the late-fee cron reads it as "still outstanding"). The invoice's running paidAmount and
  // status are likewise computed in one SQL statement from what the database holds.
  const outcome = await db.transaction(async (tx): Promise<
    | { status: "ok"; invoice: InvoiceRow; claimed: AgreementRow; repaidEntry: typeof financeLedgerEntriesTable.$inferSelect | null; updatedInvoice: { paidAmount: number; status: string } | undefined }
    | Exclude<VerifyAgreementResult, { status: "ok" } | { status: "not_confirmed" }>
  > => {
    const [invoice] = await tx.select().from(financeInvoicesTable)
      .where(and(eq(financeInvoicesTable.id, pre.invoiceId), eq(financeInvoicesTable.userId, userId))).limit(1).for("update");
    if (!invoice) return { status: "not_found" };

    const [agreement] = await tx.select().from(financePaymentAgreementsTable)
      .where(eq(financePaymentAgreementsTable.id, agreementId)).limit(1).for("update");
    if (!agreement) return { status: "not_found" };
    if (agreement.status === "creditor_verified") return { status: "already_verified" };
    if (agreement.status !== "passkey_confirmed") return { status: "changed" };

    // F21: another claim verified while this one waited may have used up the balance.
    const remaining = Math.max(0, invoice.amount - invoice.paidAmount);
    if (agreement.amount > remaining + 0.01) return { status: "exceeds_remaining", currency: invoice.currency, remaining };

    const [claimed] = await tx.update(financePaymentAgreementsTable).set({
      status: "creditor_verified", creditorVerifiedAt: new Date(), creditorVerifiedBy: userId,
      creditorNotes: notes ?? null, updatedAt: new Date(),
    }).where(and(eq(financePaymentAgreementsTable.id, agreementId), eq(financePaymentAgreementsTable.status, "passkey_confirmed"))).returning();
    if (!claimed) return { status: "already_verified" };

    let repaidEntry: typeof financeLedgerEntriesTable.$inferSelect | null = null;
    if (invoice.entryId) {
      const [entry] = await tx.select().from(financeLedgerEntriesTable)
        .where(and(eq(financeLedgerEntriesTable.id, invoice.entryId), eq(financeLedgerEntriesTable.userId, userId)));
      // Defensive re-check (POST /finance/invoices blocks linking to a non-repayable kind at creation, but older
      // invoices could still point at one) — skip posting a repayment rather than silently desyncing entry.amount
      // from the journal.
      if (entry && REPAYABLE_KINDS.has(entry.kind)) {
        await tx.insert(financeRepaymentsTable).values({
          entryId: entry.id, amount: agreement.amount, isInterest: 0,
          notes: `Verified from Payment Agreement #${agreement.id} (${PAYMENT_METHOD_LABELS[agreement.methodType] ?? agreement.methodType}${agreement.referenceId ? `, ref ${agreement.referenceId}` : ""}).`,
          paidAt: agreement.submittedAt ?? new Date(),
        });
        await applyPrincipalRepaymentTx(tx, entry.id, agreement.amount);
        repaidEntry = entry;
      }
    }

    const [updatedInvoice] = await tx.update(financeInvoicesTable).set({
      paidAmount: sql`${financeInvoicesTable.paidAmount} + ${agreement.amount}`,
      status: sql`CASE WHEN ${financeInvoicesTable.paidAmount} + ${agreement.amount} >= ${financeInvoicesTable.amount} - 0.01 THEN 'paid' ELSE 'partially_paid' END`,
      updatedAt: new Date(),
    }).where(eq(financeInvoicesTable.id, invoice.id)).returning({ paidAmount: financeInvoicesTable.paidAmount, status: financeInvoicesTable.status });
    return { status: "ok", invoice, claimed, repaidEntry, updatedInvoice };
  });
  if (outcome.status !== "ok") return outcome;

  const { invoice, claimed, repaidEntry, updatedInvoice } = outcome;
  if (repaidEntry) postRepaymentJournal(repaidEntry, claimed.amount, false).catch(() => {});
  const newPaidAmount = updatedInvoice?.paidAmount ?? invoice.paidAmount + claimed.amount;
  const invoiceStatus = updatedInvoice?.status ?? (newPaidAmount >= invoice.amount - 0.01 ? "paid" : "partially_paid");
  logInvoiceEvent(invoice.id, invoiceStatus === "paid" ? "creditor_verified" : "partially_verified", req, { agreementId, amount: claimed.amount, paidAmount: newPaidAmount }).catch(() => {});

  return { status: "ok", agreement: claimed };
}

// ─── Creditor review: dispute ────────────────────────────────────────────────

export type DisputeAgreementResult =
  | { status: "ok"; agreement: AgreementRow }
  | { status: "not_found" } // the agreement's invoice is missing or not the caller's
  | { status: "already_verified" }
  | { status: "already_disputed" };

/**
 * Creditor rejects a claim instead of verifying it, e.g. the reference does not match what landed in their account.
 * Does not touch paidAmount and posts nothing. The invoice moves to "disputed" (the payer cannot submit again until
 * the creditor reopens it), except that an invoice that is already settled or cancelled keeps its status (F20).
 */
export async function disputePaymentAgreement(
  userId: number, agreementId: number, reason: string, req: InvoiceEventRequest,
): Promise<DisputeAgreementResult> {
  const trimmed = reason.trim();

  const [pre] = await db.select({ invoiceId: financePaymentAgreementsTable.invoiceId }).from(financePaymentAgreementsTable)
    .where(eq(financePaymentAgreementsTable.id, agreementId));
  if (!pre) return { status: "not_found" };

  const outcome = await db.transaction(async (tx): Promise<
    | { status: "ok"; agreement: AgreementRow; invoice: InvoiceRow }
    | { status: "not_found" } | { status: "already_verified" } | { status: "already_disputed" }
  > => {
    const [invoice] = await tx.select().from(financeInvoicesTable)
      .where(and(eq(financeInvoicesTable.id, pre.invoiceId), eq(financeInvoicesTable.userId, userId))).limit(1).for("update");
    if (!invoice) return { status: "not_found" };

    const [agreement] = await tx.select().from(financePaymentAgreementsTable)
      .where(eq(financePaymentAgreementsTable.id, agreementId)).limit(1).for("update");
    if (!agreement) return { status: "not_found" };
    if (agreement.status === "creditor_verified") return { status: "already_verified" };
    if (agreement.status === "disputed") return { status: "already_disputed" };

    const [updated] = await tx.update(financePaymentAgreementsTable).set({
      status: "disputed", disputedAt: new Date(), disputedBy: userId, disputeReason: trimmed, updatedAt: new Date(),
    }).where(eq(financePaymentAgreementsTable.id, agreementId)).returning();

    await tx.update(financeInvoicesTable).set({
      status: sql`CASE WHEN ${financeInvoicesTable.status} IN ('paid', 'creditor_verified', 'cancelled') THEN ${financeInvoicesTable.status} ELSE 'disputed' END`,
      updatedAt: new Date(),
    }).where(eq(financeInvoicesTable.id, invoice.id));
    return { status: "ok", agreement: updated, invoice };
  });
  if (outcome.status !== "ok") return outcome;
  const { agreement, invoice } = outcome;

  logInvoiceEvent(invoice.id, "agreement_disputed", req, { agreementId, reason: trimmed }).catch(() => {});

  if (agreement.payerUserId) {
    const [payer] = await db.select({ email: usersTable.email, username: usersTable.username, telegramChatId: usersTable.telegramChatId })
      .from(usersTable).where(eq(usersTable.id, agreement.payerUserId));
    const [creditor] = await db.select({ username: usersTable.username }).from(usersTable).where(eq(usersTable.id, invoice.userId));
    const creditorName = creditor?.username ?? "the creditor";
    const url = financeInvoiceUrl(invoice.invoiceToken);
    const amountStr = money(invoice.currency, agreement.amount);

    createNotification(agreement.payerUserId, "finance_payment_disputed", "Payment disputed",
      `${creditorName} disputed your payment claim of ${amountStr}: ${trimmed}`,
      { invoiceId: invoice.id, agreementId }).catch(() => {});
    if (payer?.email) {
      sendPaymentDisputedEmail(payer.email, {
        debtorName: payer.username ?? invoice.debtorName, creditorName, title: `Invoice #${invoice.id}`,
        amount: amountStr, reason: trimmed, url,
      }).catch(() => {});
    }
    if (payer?.telegramChatId) {
      sendToUser(payer.telegramChatId, `⚠️ *Payment disputed*\n\n${creditorName} disputed your claim of ${amountStr}:\n"${trimmed}"`).catch(() => {});
    }
  }

  return { status: "ok", agreement };
}

