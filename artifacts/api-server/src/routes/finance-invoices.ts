/**
 * routes/finance-invoices.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Peer-to-peer Finance invoicing + payment-agreement evidence layer. See
 * finance/invoices/* for the token/URL helpers; the former design note in lib/finance-invoice.ts
 * moved with the code (that shim was removed in WP-8).
 *
 * WP-6a: the 11 invoice handlers are thin adapters over finance/application/invoices.ts.
 * WP-6b: the 6 payment-agreement handlers are thin adapters over finance/application/payment-agreements.ts.
 *
 *  Payment methods (creditor's own receiving destinations — informational,
 *  no gateway API integration):
 *    GET/POST   /finance/payment-methods
 *    PUT/DELETE /finance/payment-methods/:id
 *
 *  Invoices (creditor, authenticated):
 *    GET    /finance/invoices                — list, optional ?entryId=
 *    POST   /finance/invoices                — create
 *    GET    /finance/invoices/:id            — detail incl. events + agreements
 *    POST   /finance/invoices/:id/send       — email/Telegram the "Repay" link
 *    DELETE /finance/invoices/:id            — cancel
 *
 *  Public "Repay" page (token-gated, no login to view):
 *    GET  /finance/invoices/public/:token
 *    POST /finance/invoices/public/:token/submit-payment   — requires login
 *
 *  Public "Payment Agreement" page (token-gated):
 *    GET  /finance/payment-agreements/public/:token
 *    POST /finance/payment-agreements/public/:token/passkey/options — requires login (must be the payer)
 *    POST /finance/payment-agreements/public/:token/passkey/verify  — requires login (must be the payer)
 *    GET  /finance/payment-agreements/public/:token/evidence-pdf    — token-gated, no login
 *
 *  Creditor review:
 *    POST /finance/payment-agreements/:id/verify — posts the real repayment
 */
import { Router } from "express";
import type { Request, Response } from "express";
import {
  db,
  financePaymentMethodsTable,
  financeInvoicesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, getRequestUser, pepDecisionObserver } from "../middlewares/auth";
import { requireOwnership, requirePublicAudit } from "../lib/policy/pep/middleware";
import { authorize } from "../lib/policy/pep";
import type { ResourceRefBuilder } from "../lib/policy/pep/types";
import { PolicyEngine } from "../lib/policy/policy-engine";
import { createResourceOwnershipRule } from "../lib/policy/resource";
import { getWebAuthnConfig, consumeChallenge } from "../lib/passkey";
import {
  createFinancePaymentMethod,
  deleteFinancePaymentMethod,
  listFinancePaymentMethods,
  resetFinancePaymentMethodDefaults,
  updateFinancePaymentMethod,
} from "../finance/application/payment-methods";
import { getInvoiceBranding, updateInvoiceBranding } from "../finance/application/invoice-branding";
import {
  listInvoices, createInvoice, updateInvoiceLineItems, getInvoiceDetail, streamCreditorInvoicePdf,
  sendInvoice, cancelInvoice, getPublicInvoiceView, streamPublicInvoicePdf, submitInvoicePayment,
  reopenInvoice, parseLineItemsFromBody, findInvoiceOwnerId, iso,
} from "../finance/application/invoices";
import {
  findAgreementByToken, findAgreementInvoiceOwner, getPublicAgreementView, createPasskeyOptions,
  confirmAgreementWithPasskey, streamAgreementEvidencePdf, verifyPaymentAgreement, disputePaymentAgreement,
} from "../finance/application/payment-agreements";

const router = Router();

function paramString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

// ─── Payment methods ──────────────────────────────────────────────────────────

// ─── Route Integration Roadmap — Season C, Phase C3 (mechanical sweep, batch 3) ──
// Flagged in Phase C1's own "still to do" list ("finance-invoices.ts (988
// lines) — big, deserves its own batch") and left untouched through C1/C2.
// This file has FOUR distinct hand-rolled ownership questions, not one:
//  1. does this payment method belong to me (payment-methods :id)
//  2. does this invoice belong to me, the creditor (invoices :id, and the
//     invoiceId a payment agreement points at)
//  3. does this payment agreement belong to me, the PAYER (the public
//     Payment Agreement passkey flow — a different ownerId column,
//     payerUserId, on the very same table Q2 above cares about via a
//     different column, userId-of-the-linked-invoice)
//  4. does this in-memory passkey challenge belong to me (same shape as
//     Phase C2's passkey.ts register/verify challenge check)
// None of these have an admin bypass anywhere in this file (unlike Phase
// C1's support.ts/tasks.ts) — every one is "owner, full stop", same as
// Phase C2's passkey.ts/vault-reauth.ts. So `createResourceOwnershipRule()`
// alone is enough throughout; `createRoleOverrideRule()` is not needed here
// and is not registered.
//
// ── Two call shapes, same split Phase C1/C2 already established ──────────
// Where the existing hand-rolled check is the FIRST thing a handler does
// after auth (no validation, no other resource's existence check ahead of
// it), the router-level `requireOwnership()` middleware (Phase B1's
// finance.ts pattern) is used directly — `GET/POST/.../:id`-shaped routes
// below. Where something else already runs first — a body-shape validation
// (400), a DIFFERENT resource's existence check (404), or a side-effecting
// write that happens regardless of :id ownership (the payment-method
// `isDefault` reset) — moving the check to router-level middleware would
// run it BEFORE that existing step and change which response/side-effect a
// non-owner sees first, exactly the ordering hazard Phase C1/C2 already
// worked out for support.ts/tasks.ts/passkey.ts. Those routes use inline
// `authorize()` instead, at the exact point ownership was already being
// decided, same as those two phases.
//
// ── Resource lookup, not request-supplied ownerId — same as B1/C1/C2 ─────
// Every ResourceRefBuilder/inline lookup below re-reads the REAL owner
// from the DB by :id (or reuses an already-fetched row's own DB-sourced
// column, e.g. `agreement.payerUserId`) — never a client-supplied id.
// `FINANCE_INVOICE_OWNER_SENTINEL_NONE` (never a real user id —
// `usersTable.id` is a positive serial) plays the same role
// `FINANCE_OWNER_SENTINEL_NONE`/`PASSKEY_OWNER_SENTINEL_NONE`/
// `VAULT_REAUTH_OWNER_SENTINEL_NONE` already play in finance.ts/passkey.ts/
// vault-reauth.ts: a missing row still reaches the PDP as a normal,
// auditable DENY (`NO_MATCHING_POLICY`), not a 500 — and `onDeny`/the
// inline gate below renders the exact same error body these routes always
// returned for "doesn't exist" as well as "exists but isn't yours".
const FINANCE_INVOICE_OWNER_SENTINEL_NONE = -1;

const financePaymentMethodResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(paramString(req.params.id), 10);
  if (!Number.isFinite(id)) return { type: "finance.payment_method", id: req.params.id, ownerId: FINANCE_INVOICE_OWNER_SENTINEL_NONE };
  const [row] = await db.select({ userId: financePaymentMethodsTable.userId }).from(financePaymentMethodsTable)
    .where(eq(financePaymentMethodsTable.id, id)).limit(1);
  return { type: "finance.payment_method", id, ownerId: row?.userId ?? FINANCE_INVOICE_OWNER_SENTINEL_NONE };
};

const financeInvoiceResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(paramString(req.params.id), 10);
  if (!Number.isFinite(id)) return { type: "finance.invoice", id: req.params.id, ownerId: FINANCE_INVOICE_OWNER_SENTINEL_NONE };
  const [row] = await db.select({ userId: financeInvoicesTable.userId }).from(financeInvoicesTable)
    .where(eq(financeInvoicesTable.id, id)).limit(1);
  return { type: "finance.invoice", id, ownerId: row?.userId ?? FINANCE_INVOICE_OWNER_SENTINEL_NONE };
};

function requireFinancePaymentMethodOwnership(action: string) {
  return requireOwnership(action, financePaymentMethodResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => { res.status(404).json({ error: "Payment method not found" }); },
  });
}

function requireFinanceInvoiceOwnership(action: string) {
  return requireOwnership(action, financeInvoiceResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => { res.status(404).json({ error: "Invoice not found" }); },
  });
}

// Shared by every INLINE `authorize()` call below (the "something else runs
// first" routes) — one engine, module-load-time, cheap/stateless, same
// single-engine-per-file posture Phase C2's `passkeyOwnershipEngine` already
// established for a file with more than one resource type/action on it.
const financeInvoicesOwnershipEngine = new PolicyEngine({ onDecision: pepDecisionObserver });
financeInvoicesOwnershipEngine.registerRule("resource-ownership", createResourceOwnershipRule());

router.get("/finance/payment-methods", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const rows = await listFinancePaymentMethods(authUser.userId);
  res.json(rows.map(r => ({ ...r, createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt) })));
});

router.post("/finance/payment-methods", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const body = req.body as Record<string, any>;
  if (!body.methodType) { res.status(400).json({ error: "methodType is required" }); return; }

  const row = await createFinancePaymentMethod(authUser.userId, body);
  res.status(201).json({ ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) });
});

router.put("/finance/payment-methods/:id", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const body = req.body as Record<string, any>;

  if (body.isDefault) await resetFinancePaymentMethodDefaults(authUser.userId);

  // Phase C3: PDP-routed ownership check, placed AFTER the isDefault reset
  // above on purpose — that reset already ran unconditionally regardless of
  // whether :id belongs to this user (existing behavior, unchanged; this
  // phase doesn't touch it, per Rule: don't remove a working system). Using
  // router-level `requireOwnership()` middleware instead would run ahead of
  // that reset, which is exactly the ordering hazard Phase C1/C2 already
  // worked out for support.ts/tasks.ts/passkey.ts.
  const [pmOwnerRow] = await db.select({ userId: financePaymentMethodsTable.userId })
    .from(financePaymentMethodsTable).where(eq(financePaymentMethodsTable.id, id)).limit(1);
  const pmOwnership = await authorize({
    req, engine: financeInvoicesOwnershipEngine, action: "finance.payment_method.update",
    resource: { type: "finance.payment_method", id, ownerId: pmOwnerRow?.userId ?? FINANCE_INVOICE_OWNER_SENTINEL_NONE },
  });
  if (pmOwnership.decision.effect !== "ALLOW") { res.status(404).json({ error: "Payment method not found" }); return; }

  const row = await updateFinancePaymentMethod(authUser.userId, id, body);
  if (!row) { res.status(404).json({ error: "Payment method not found" }); return; } // unreachable given ALLOW above, kept as defensive/unchanged
  res.json({ ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) });
});

router.delete("/finance/payment-methods/:id", requireAuth, requireFinancePaymentMethodOwnership("finance.payment_method.delete"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const deleted = await deleteFinancePaymentMethod(authUser.userId, id);
  if (!deleted) { res.status(404).json({ error: "Payment method not found" }); return; }
  res.json({ success: true });
});

// ─── Invoices (creditor side) ─────────────────────────────────────────────────

router.get("/finance/invoices", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const entryId = req.query.entryId ? parseInt(paramString(req.query.entryId as any), 10) : undefined;

  const rows = await listInvoices(authUser.userId, entryId);
  res.json(rows.map(r => ({
    ...r, dueDate: iso(r.dueDate), lastSentAt: iso(r.lastSentAt), cancelledAt: iso(r.cancelledAt),
    createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt),
  })));
});

router.post("/finance/invoices", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const body = req.body as Record<string, any>;
  const lineItems = parseLineItemsFromBody(body);
  if (!body.debtorName || lineItems.filter(l => l.description).length === 0) {
    res.status(400).json({ error: "debtorName and at least one line item (description + amount) are required" }); return;
  }
  if (!body.debtorEmail && !body.debtorTelegramChatId) {
    res.status(400).json({ error: "Provide at least a debtorEmail or debtorTelegramChatId to send the invoice to" }); return;
  }

  const result = await createInvoice(authUser.userId, body, lineItems);
  if (result.status === "entry_not_found") { res.status(404).json({ error: "Linked entry not found" }); return; }
  if (result.status === "entry_not_repayable") {
    res.status(400).json({ error: `Invoices can't be linked to '${result.kind}' entries — they're recorded as fully settled at creation.` });
    return;
  }

  res.status(201).json({
    ...result.invoice, dueDate: iso(result.invoice.dueDate), createdAt: iso(result.invoice.createdAt), updatedAt: iso(result.invoice.updatedAt),
    lineItems: result.lineItems,
  });
});

// Replaces every line item on an invoice and recomputes its total — blocked
// once money has actually moved against it (a payment claim submitted or
// verified), same as the rest of this file protects a settled invoice from
// being quietly edited out from under a debtor who already paid.
router.put("/finance/invoices/:id/line-items", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const body = req.body as Record<string, any>;
  const { lineItems } = body as { lineItems?: any[] };
  if (!Array.isArray(lineItems) || lineItems.length === 0) { res.status(400).json({ error: "lineItems must be a non-empty array" }); return; }

  // Phase C3: PDP-routed ownership check, placed AFTER the lineItems
  // shape validation above (unchanged — a malformed body still gets 400
  // before ownership is even considered, same order as before this phase).
  const liOwnership = await authorize({
    req, engine: financeInvoicesOwnershipEngine, action: "finance.invoice.line_items.update",
    resource: { type: "finance.invoice", id, ownerId: (await findInvoiceOwnerId(id)) ?? FINANCE_INVOICE_OWNER_SENTINEL_NONE },
  });
  if (liOwnership.decision.effect !== "ALLOW") { res.status(404).json({ error: "Invoice not found" }); return; }

  const result = await updateInvoiceLineItems(authUser.userId, id, body, lineItems);
  if (result.status === "not_found") { res.status(404).json({ error: "Invoice not found" }); return; }
  if (result.status === "locked") {
    res.status(400).json({ error: "This invoice already has a payment claim on it — cancel it and create a new one instead of editing the lines." }); return;
  }

  const row = result.invoice;
  res.json({ ...row, dueDate: iso(row.dueDate), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt), lineItems: result.lineItems });
});

router.get("/finance/invoices/:id", requireAuth, requireFinanceInvoiceOwnership("finance.invoice.read"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const detail = await getInvoiceDetail(authUser.userId, id);
  if (!detail) { res.status(404).json({ error: "Invoice not found" }); return; }
  const { invoice, events, agreements, lineItems } = detail;

  res.json({
    ...invoice, dueDate: iso(invoice.dueDate), lastSentAt: iso(invoice.lastSentAt),
    cancelledAt: iso(invoice.cancelledAt), createdAt: iso(invoice.createdAt), updatedAt: iso(invoice.updatedAt),
    lineItems,
    events: events.map(e => ({ ...e, createdAt: iso(e.createdAt) })),
    agreements: agreements.map(a => ({
      ...a, submittedAt: iso(a.submittedAt), confirmedAt: iso(a.confirmedAt),
      creditorVerifiedAt: iso(a.creditorVerifiedAt), createdAt: iso(a.createdAt), updatedAt: iso(a.updatedAt),
    })),
  });
});

// Creditor's own branded, itemized copy of the invoice — same renderer and
// same branding fields as the public download below, just authenticated
// and addressed by invoice id instead of token.
router.get("/finance/invoices/:id/pdf", requireAuth, requireFinanceInvoiceOwnership("finance.invoice.read_pdf"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  if (!(await streamCreditorInvoicePdf(res, authUser.userId, id))) { res.status(404).json({ error: "Invoice not found" }); return; }
});

router.post("/finance/invoices/:id/send", requireAuth, requireFinanceInvoiceOwnership("finance.invoice.send"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const { channels } = req.body as { channels?: string[] };

  const result = await sendInvoice(authUser.userId, id, channels, req);
  if (result.status === "not_found") { res.status(404).json({ error: "Invoice not found" }); return; }
  res.json({ sentEmail: result.sentEmail, sentTelegram: result.sentTelegram, url: result.url });
});

router.delete("/finance/invoices/:id", requireAuth, requireFinanceInvoiceOwnership("finance.invoice.cancel"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  // A paid invoice can be cancelled only as an appeal: the creditor says the verified payment was not received (fake or
  // reversed) and gives a reason; the payment is then reversed with the cancel. Without a reason a paid invoice is refused.
  const body = (req.body ?? {}) as { reason?: unknown };
  const rawReason = body.reason ?? (typeof req.query.reason === "string" ? req.query.reason : undefined);
  const reason = typeof rawReason === "string" ? rawReason.trim() : undefined;
  if (rawReason !== undefined && (typeof rawReason !== "string" || reason!.length < 3 || reason!.length > 500)) {
    res.status(400).json({ error: "reason must be 3 to 500 characters." }); return;
  }
  const result = await cancelInvoice(authUser.userId, id, { reversePayments: reason ? { reason } : undefined, req });
  if (result.status === "not_found") { res.status(404).json({ error: "Invoice not found" }); return; }
  if (result.status === "already_paid") { res.status(400).json({ error: "A paid invoice can't be cancelled unless you appeal it: send a reason saying the payment was not received, and the payment will be reversed." }); return; }
  res.json({ success: true, ...(result.reversedAmount ? { reversedAmount: result.reversedAmount } : {}) });
});

// ─── Public "Repay" page ──────────────────────────────────────────────────────

router.get("/finance/invoices/public/:token", requirePublicAudit("finance_invoice_public.view", { onDecision: pepDecisionObserver }), async (req, res): Promise<void> => {
  const token = paramString(req.params.token);
  const view = await getPublicInvoiceView(token, req);
  if (!view) { res.status(404).json({ error: "This invoice link is invalid or has been cancelled." }); return; }
  res.json(view);
});

// Same branded, itemized PDF as the authenticated creditor copy above, but
// reached by anyone holding the invoice token — no login, matching every
// other public/:token surface in this file (e.g. the evidence PDF below).
router.get("/finance/invoices/public/:token/pdf", requirePublicAudit("finance_invoice_public.pdf", { onDecision: pepDecisionObserver }), async (req, res): Promise<void> => {
  const token = paramString(req.params.token);
  if (!(await streamPublicInvoicePdf(res, token))) { res.status(404).json({ error: "This invoice link is invalid or has been cancelled." }); return; }
});

// ─── Invoice branding (per-user logo/theme, reused on every invoice) ─────────

router.get("/finance/invoice-branding", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  res.json(await getInvoiceBranding(authUser.userId));
});

router.put("/finance/invoice-branding", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const body = req.body as Record<string, any>;
  if (body.themeColor && !/^#[0-9a-fA-F]{6}$/.test(body.themeColor)) {
    res.status(400).json({ error: "themeColor must be a 6-digit hex color, e.g. #00a89f" }); return;
  }
  res.json(await updateInvoiceBranding(authUser.userId, body));
});

router.post("/finance/invoices/public/:token/submit-payment", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const token = paramString(req.params.token);
  const { methodType, referenceId, amount } = req.body as { methodType?: string; referenceId?: string; amount?: number };
  if (!methodType) { res.status(400).json({ error: "methodType is required" }); return; }

  const result = await submitInvoicePayment(authUser.userId, token, { methodType, referenceId, amount }, req);
  switch (result.status) {
    case "invalid_link": res.status(404).json({ error: "This invoice link is invalid or has been cancelled." }); return;
    case "already_paid": res.status(400).json({ error: "This invoice is already fully paid." }); return;
    case "disputed": res.status(400).json({ error: "This invoice's last payment claim was disputed. Contact the creditor before submitting a new one." }); return;
    case "invalid_amount": res.status(400).json({ error: "amount must be a positive number." }); return;
    case "exceeds_remaining": res.status(400).json({ error: `Amount exceeds the remaining balance of ${result.currency} ${result.remaining.toLocaleString()}.` }); return;
    case "pending_claims": res.status(409).json({ error: result.available > 0.01
      ? `Other payment claims totalling ${result.currency} ${result.pending.toLocaleString()} are waiting for the creditor to review. You can claim at most ${result.currency} ${result.available.toLocaleString()} until they are verified or disputed.`
      : `Payment claims totalling ${result.currency} ${result.pending.toLocaleString()} already cover this invoice and are waiting for the creditor to review.` }); return;
  }
  res.status(201).json({ agreementToken: result.agreementToken, agreementUrl: result.agreementUrl });
});

// ─── Public "Payment Agreement" page ─────────────────────────────────────────
// WP-6b: the six payment-agreement handlers are thin adapters over finance/application/payment-agreements.ts. The
// routes keep authentication, id and body-shape validation, every PDP ownership check (and its ordering), the
// WebAuthn config read from the request, the challenge consumption and response formatting.

router.get("/finance/payment-agreements/public/:token", requirePublicAudit("finance_payment_agreement_public.view", { onDecision: pepDecisionObserver }), async (req, res): Promise<void> => {
  const token = paramString(req.params.token);
  const view = await getPublicAgreementView(token);
  if (!view) { res.status(404).json({ error: "This payment agreement link is invalid." }); return; }
  res.json(view);
});

router.post("/finance/payment-agreements/public/:token/passkey/options", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const token = paramString(req.params.token);
  const agreement = await findAgreementByToken(token);
  if (!agreement) { res.status(404).json({ error: "This payment agreement link is invalid." }); return; }
  // Phase C3: PDP-routed, replacing the hand-rolled `!==` directly — same
  // shape `vault-reauth.ts`'s Phase C2 check used (a real, DB-sourced
  // column already fetched above, no new query needed; the comparison
  // gates what happens next, it isn't itself a "final enforcement" DB
  // write the way passkey.ts's PATCH/DELETE were, so there's no ordering
  // reason to keep a separate hand-rolled copy around this one).
  const payerOwnership = await authorize({
    req, engine: financeInvoicesOwnershipEngine, action: "finance.payment_agreement.passkey_options",
    resource: { type: "finance.payment_agreement", id: agreement.id, ownerId: agreement.payerUserId ?? FINANCE_INVOICE_OWNER_SENTINEL_NONE },
  });
  if (payerOwnership.decision.effect !== "ALLOW") { res.status(403).json({ error: "This payment agreement doesn't belong to your account." }); return; }
  if (agreement.status !== "submitted") { res.status(400).json({ error: `This agreement is already ${agreement.status}.` }); return; }

  const result = await createPasskeyOptions(authUser.userId, getWebAuthnConfig(req).rpID);
  if (result.status === "no_passkey") { res.status(400).json({ error: "No passkey registered on your account yet. Add one in Settings → Security before confirming." }); return; }
  res.json({ options: result.options, challengeKey: result.challengeKey });
});

router.post("/finance/payment-agreements/public/:token/passkey/verify", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const token = paramString(req.params.token);
  const { challengeKey, response } = req.body as { challengeKey?: string; response?: any };
  if (!challengeKey || !response) { res.status(400).json({ error: "challengeKey and response are required" }); return; }

  const agreement = await findAgreementByToken(token);
  if (!agreement) { res.status(404).json({ error: "This payment agreement link is invalid." }); return; }
  // Phase C3: same payer-ownership check as passkey/options above, PDP-routed.
  const payerOwnership = await authorize({
    req, engine: financeInvoicesOwnershipEngine, action: "finance.payment_agreement.passkey_verify",
    resource: { type: "finance.payment_agreement", id: agreement.id, ownerId: agreement.payerUserId ?? FINANCE_INVOICE_OWNER_SENTINEL_NONE },
  });
  if (payerOwnership.decision.effect !== "ALLOW") { res.status(403).json({ error: "This payment agreement doesn't belong to your account." }); return; }
  if (agreement.status !== "submitted") { res.status(400).json({ error: `This agreement is already ${agreement.status}.` }); return; }

  // Phase C3: a SECOND, distinct ownership question — the in-memory
  // WebAuthn challenge's own userId, same shape as Phase C2's
  // `passkey.ts` register/verify challenge check. `!entry` (expired/
  // unknown challengeKey) stays hand-rolled — existence, not ownership,
  // same split Phase C1/C2 already draw. Only the ownership half
  // (`entry.userId !== authUser.userId`) goes through the PDP; same
  // combined "Challenge expired or invalid. Try again." response either
  // way, byte-for-byte.
  const entry = consumeChallenge(challengeKey);
  if (!entry) { res.status(400).json({ error: "Challenge expired or invalid. Try again." }); return; }
  const challengeOwnership = await authorize({
    req, engine: financeInvoicesOwnershipEngine, action: "finance.payment_agreement.passkey_challenge.verify",
    resource: { type: "finance.payment_agreement_passkey_challenge", id: challengeKey, ownerId: entry.userId ?? FINANCE_INVOICE_OWNER_SENTINEL_NONE },
  });
  if (challengeOwnership.decision.effect !== "ALLOW") { res.status(400).json({ error: "Challenge expired or invalid. Try again." }); return; }

  if (!response.id) { res.status(400).json({ error: "Malformed passkey response" }); return; }

  const webAuthn = getWebAuthnConfig(req);
  const result = await confirmAgreementWithPasskey(authUser.userId, agreement, { challenge: entry.challenge, response, rpID: webAuthn.rpID, origin: webAuthn.origin }, req);
  switch (result.status) {
    case "not_registered": res.status(401).json({ error: "This passkey is not registered on your account" }); return;
    case "failed": res.status(401).json({ error: result.message }); return;
    case "not_submitted": res.status(400).json({ error: `This agreement is already ${result.current}.` }); return;
  }
  res.json({
    verified: true,
    evidencePdfUrl: `${process.env.APP_URL ?? "https://ayzen.replit.app"}/api/finance/payment-agreements/public/${token}/evidence-pdf`,
  });
});

router.get("/finance/payment-agreements/public/:token/evidence-pdf", requirePublicAudit("finance_payment_agreement_public.evidence_pdf", { onDecision: pepDecisionObserver }), async (req, res): Promise<void> => {
  const token = paramString(req.params.token);
  if (!(await streamAgreementEvidencePdf(res, token))) {
    res.status(404).json({ error: "This evidence document isn't available yet." }); return;
  }
});

// ─── Creditor review ──────────────────────────────────────────────────────────

router.post("/finance/payment-agreements/:id/verify", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const { notes } = req.body as { notes?: string };

  const found = await findAgreementInvoiceOwner(id);
  if (!found) { res.status(404).json({ error: "Payment agreement not found" }); return; }

  // Phase C3: PDP-routed ownership check ahead of the use case, whose own
  // lookup is filtered by the caller's userId as well (kept — this phase
  // added a second, observable layer, same "don't remove a working
  // system" posture Phase B1/C1/C2 established). Ownership here is on the
  // INVOICE the agreement points at, the creditor side — a different
  // question from the payer-ownership checks above.
  const verifyInvoiceOwnership = await authorize({
    req, engine: financeInvoicesOwnershipEngine, action: "finance.payment_agreement.verify",
    resource: { type: "finance.invoice", id: found.invoiceId, ownerId: found.ownerId ?? FINANCE_INVOICE_OWNER_SENTINEL_NONE },
  });
  if (verifyInvoiceOwnership.decision.effect !== "ALLOW") { res.status(404).json({ error: "Invoice not found" }); return; }

  const result = await verifyPaymentAgreement(authUser.userId, id, notes, req);
  switch (result.status) {
    case "not_found": res.status(404).json({ error: "Invoice not found" }); return;
    case "not_confirmed": res.status(400).json({ error: "This agreement hasn't been passkey-confirmed by the payer yet." }); return;
    case "already_verified": res.status(409).json({ error: "This agreement has already been verified." }); return;
    case "changed": res.status(409).json({ error: "This agreement changed while it was being verified (for example it was disputed). Reload and review it again." }); return;
    case "exceeds_remaining": res.status(409).json({ error: `This claim is more than the remaining balance of ${result.currency} ${result.remaining.toLocaleString()} (other payments were verified first). Dispute it instead.` }); return;
  }
  const a = result.agreement;
  res.json({ ...a, confirmedAt: iso(a.confirmedAt), creditorVerifiedAt: iso(a.creditorVerifiedAt) });
});

// Creditor rejects a passkey-confirmed claim instead of verifying it — e.g.
// the reference/txn ID doesn't match what actually landed in their account.
// Does NOT touch paidAmount or post anything; the invoice moves to
// "disputed" (a settled or cancelled invoice keeps its status) until the
// creditor reopens it below.
router.post("/finance/payment-agreements/:id/dispute", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const { reason } = req.body as { reason?: string };
  if (!reason || !reason.trim()) { res.status(400).json({ error: "A reason is required to dispute a payment claim." }); return; }

  const found = await findAgreementInvoiceOwner(id);
  if (!found) { res.status(404).json({ error: "Payment agreement not found" }); return; }

  // Phase C3: same PDP-routed ownership check as /verify above, ahead of
  // the use case (whose own lookup is filtered by the caller's userId too).
  const disputeInvoiceOwnership = await authorize({
    req, engine: financeInvoicesOwnershipEngine, action: "finance.payment_agreement.dispute",
    resource: { type: "finance.invoice", id: found.invoiceId, ownerId: found.ownerId ?? FINANCE_INVOICE_OWNER_SENTINEL_NONE },
  });
  if (disputeInvoiceOwnership.decision.effect !== "ALLOW") { res.status(404).json({ error: "Invoice not found" }); return; }

  const result = await disputePaymentAgreement(authUser.userId, id, reason, req);
  switch (result.status) {
    case "not_found": res.status(404).json({ error: "Invoice not found" }); return;
    case "already_verified": res.status(400).json({ error: "This agreement was already verified — it can't be disputed." }); return;
    case "already_disputed": res.status(400).json({ error: "This agreement is already disputed." }); return;
  }
  res.json({ ...result.agreement, disputedAt: iso(result.agreement.disputedAt) });
});

// Creditor's counterpart to dispute(): the dispute handler above sets the
// invoice to a real "disputed" status (not the "payment_submitted" its own
// comment claims) — and the public submit-payment route explicitly refuses
// a fresh claim while status is "disputed", and the frontend's own
// alreadySubmitted check refuses one for "payment_submitted"/
// "agreement_confirmed" too. Put together, nothing ever moved a disputed
// invoice back out of that status, so once disputed it was permanently
// stuck: the payer blocked from submitting again, and the creditor with no
// action to unblock them either. This gives the creditor that action.
router.post("/finance/invoices/:id/reopen", requireAuth, requireFinanceInvoiceOwnership("finance.invoice.reopen"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);

  const result = await reopenInvoice(authUser.userId, id, req);
  if (result.status === "not_found") { res.status(404).json({ error: "Invoice not found" }); return; }
  if (result.status === "not_disputed") { res.status(400).json({ error: "Only a disputed invoice can be reopened." }); return; }
  const row = result.invoice;
  res.json({ ...row, dueDate: iso(row.dueDate), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) });
});

export default router;
