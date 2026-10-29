import { Router } from "express";
import express from "express";
import type { Request, Response } from "express";
import {
  db,
  financePartiesTable,
  financeLedgerEntriesTable,
  financeRepaymentsTable,
  financeAssetsTable,
  financeInvoiceLinesTable,
  financeRecurringRulesTable,
  financeBudgetsTable,
  financeCurrencyRatesTable,
  financeAttachmentsTable,
  financeBooksTable,
  financeReportSchedulesTable,
  projectsTable,
} from "@workspace/db";
import { eq, and, isNotNull, gte, lte, desc, inArray } from "drizzle-orm";
import { requireAuth, getRequestUser, pepDecisionObserver } from "../middlewares/auth";
import { requireOwnership, requirePublicAudit } from "../lib/policy/pep/middleware";
import type { ResourceRefBuilder } from "../lib/policy/pep/types";
import { toCsv } from "../lib/csv";
import PDFDocument from "pdfkit";
import { hasCreditBalance, chargeCredits } from "../services/credit-meter";
import {
  listRecurringRules, createRecurringRule, updateRecurringRule, deleteRecurringRule, runRecurringNow,
} from "../finance/application/recurring";
import {
  listEntries, createEntry, updateEntry, deleteEntry, listRepayments, addRepayment,
  listEntryAttachments, uploadEntryAttachment, getEntryAttachment, deleteEntryAttachment,
  listInvoiceLines, replaceInvoiceLines, importEntriesCsv, MAX_ATTACHMENT_BYTES, type InvoiceLineInput,
} from "../finance/application/entries";
import { listJournal, getJournalEntry, createManualJournal, deleteManualJournal } from "../finance/application/journal";
import {
  listAssets, createAsset, updateAsset, deleteAsset, listAmortization, generateAmortization,
  listDepreciation, generateDepreciation, postDepreciationPeriod, payAmortizationInstallment,
} from "../finance/application/assets";
import { financeAccountsTable, financeJournalEntriesTable, financeJournalLinesTable, financeAmortizationTable, financeDepreciationTable, financeGoalsTable, financeNetWorthSnapshotsTable } from "@workspace/db";
import { computeNetWorthBreakdown, snapshotNetWorth, listNetWorthHistory, syncGoalProgress } from "../finance/application/networth";
import { listParties, createParty, updateParty, deleteParty } from "../finance/application/parties";
import { listCurrencyRates, upsertCurrencyRate } from "../finance/application/currencies";
import {
  REPORT_SCHEDULE_TYPES, listReportSchedules, createReportSchedule, updateReportSchedule, deleteReportSchedule,
} from "../finance/application/report-schedules";
import {
  listGoals, createGoal, updateGoal, contributeToGoal, deleteGoal,
  listBudgetsWithSpent, upsertBudget, deleteBudget,
} from "../finance/application/goals-budgets";
import {
  getBalanceSheetReport,
  getCashFlowReport,
  getCustomFinanceReport,
  getFinanceAnalytics,
  getFinanceExportRows,
  getFinanceInsights,
  getFinanceProjections,
  getFinanceSummary,
  getProjectInvestments,
  getIncomeStatementReport,
  getRateMap,
  getTrialBalanceReport,
  toBase,
  type CustomFinanceReport,
} from "../finance/application/reports";
import { createNotification } from "./notifications";
import {
  previewQuickEntries, commitQuickEntries, scanReceipt, getSmsWebhookInfo, rotateSmsWebhookInfo, ingestSmsWebhook,
  detectAnomalies, answerFinanceQuery, detectRecurringCandidates,
  type QuickEntryCommitInput,
} from "../finance/application/ai";
import {
  listUserBooks, createBook, updateBook, setDefaultBook, deleteBook,
  listAccounts, createAccount, updateAccount, deleteAccount,
} from "../finance/application/books-accounts";
import { mintEntryReceiptLink, revokeEntryReceiptLink, findByReceiptToken, fmtPublicReceipt, renderReceiptPdf } from "../finance/application/receipts";

const router = Router();

// Attachment uploads need a bigger body than the app-wide JSON_BODY_LIMIT
// (default 1mb) allows — base64 alone adds ~33% overhead on top of
// MAX_ATTACHMENT_BYTES. Scoped to just the attachment routes, same pattern
// as routes/vault-attachments.ts.
const uploadBodyParser = express.json({ limit: "12mb" });

function paramString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function iso(d: Date | string | null | undefined) {
  if (!d) return null;
  return typeof d === "string" ? d : d.toISOString();
}

function fmtEntry(e: typeof financeLedgerEntriesTable.$inferSelect) {
  return {
    ...e,
    dueDate: iso(e.dueDate),
    occurredDate: iso(e.occurredDate),
    createdAt: iso(e.createdAt),
    updatedAt: iso(e.updatedAt),
  };
}
function fmtAsset(a: typeof financeAssetsTable.$inferSelect) {
  return {
    ...a,
    purchaseDate: iso(a.purchaseDate),
    maturityDate: iso(a.maturityDate),
    createdAt: iso(a.createdAt),
    updatedAt: iso(a.updatedAt),
  };
}

// ─── Books (Phase 3 — Multi-book: Business vs Personal separate ledgers) ────
// Scoped to Accounts + Journal + Ledger entries only — see migrations/030_
// finance_multi_book.sql and lib/finance-accounting.ts (resolveBookId,
// listBooks) for what "a book" does and doesn't cover.

router.get("/finance/books", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  res.json(await listUserBooks(authUser.userId));
});

router.post("/finance/books", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { name, bookType, currency, notes } = req.body as { name?: string; bookType?: string; currency?: string; notes?: string };
  if (!name?.trim()) { res.status(400).json({ error: "name is required" }); return; }
  res.status(201).json(await createBook(authUser.userId, { name, bookType, currency, notes }));
});

router.put("/finance/books/:id", requireAuth, requireFinanceBookOwnership("finance.book.update"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const { name, bookType, currency, notes } = req.body as { name?: string; bookType?: string; currency?: string; notes?: string };
  const row = await updateBook(authUser.userId, id, { name, bookType, currency, notes });
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(row);
});

// Sets this book as the default (the one bookId-less requests fall back to)
// — unsets any other default for the user first, so exactly one stays true.
router.put("/finance/books/:id/set-default", requireAuth, requireFinanceBookOwnership("finance.book.set_default"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const row = await setDefaultBook(authUser.userId, id);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(row);
});

router.delete("/finance/books/:id", requireAuth, requireFinanceBookOwnership("finance.book.delete"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const outcome = await deleteBook(authUser.userId, id);
  if (outcome.status === "not_found") { res.status(404).json({ error: "Not found" }); return; }
  if (outcome.status === "is_default") { res.status(400).json({ error: "Can't delete the default book — set another book as default first" }); return; }
  if (outcome.status === "has_entries") { res.status(400).json({ error: "Book has entries and can't be deleted" }); return; }
  res.json({ success: true });
});

// ─── Route Integration Roadmap — Season B, Phase B1 (Finance ownership) ─────
// `requireAuth` alone never actually protected a single Finance record from
// another authenticated user — every handler below does its own hand-rolled
// `eq(table.userId, authUser.userId)` scoping (`assertEntryOwnership()` for
// ledger entries, an inline `where` for parties). That scoping is correct
// and stays exactly as-is — this phase does not remove it (Rule: don't
// remove a working system). What it adds is a SECOND, PDP-routed ownership
// check ahead of it, via `requireOwnership()` (`lib/policy/pep/middleware.ts`,
// Phase 19) — so a Finance ownership decision now produces a real
// `AuthorizationDecision` (a `requestId`, a reason code, a durable
// `authorization_audit_log` row and a `authorization-telemetry` metric via
// the same `pepDecisionObserver` the Phase A2/A3 RBAC-PEP shim already
// wires into `middlewares/auth.ts`) instead of being invisible to the PDP
// the way it was for the RBAC-based routes before Season A even started.
//
// ── Resource lookup, not request-supplied ownerId ───────────────────────
// Each `ResourceRefBuilder` below re-reads the record's REAL owner from the
// DB by :id — never trusts a client-supplied ownerId (same boundary
// `ownership-rule.ts`'s own header draws around `ResourceRef.ownerId`
// being "only as trustworthy as the PEP call site that populated it").
//
// ── A record that doesn't exist at all is still a DENY, not a thrown
//    wiring error ─────────────────────────────────────────────────────────
// `requireOwnership()` treats an unset `ownerId` as a construction-time
// mistake (see its own header) — appropriate for a resource builder that
// forgot to populate it, wrong for "the row this :id names doesn't exist".
// `FINANCE_OWNER_SENTINEL_NONE` (never a real user id — `usersTable.id` is
// a positive serial) is used instead so a missing row still reaches the
// PDP as a normal, auditable DENY (`NO_MATCHING_POLICY` — no rule can ever
// match `ownerId === -1`), not a 500. `onDeny` below then renders the exact
// same 404 body these routes already returned for BOTH "doesn't exist" and
// "exists but isn't yours" — this phase does not change what a caller can
// observe about whether a given id exists, only how the decision that
// blocks it gets made and recorded.
const FINANCE_OWNER_SENTINEL_NONE = -1;

const financePartyResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(paramString(req.params.id), 10);
  if (!Number.isFinite(id)) return { type: "finance.party", id: req.params.id, ownerId: FINANCE_OWNER_SENTINEL_NONE };
  const [row] = await db.select({ userId: financePartiesTable.userId }).from(financePartiesTable)
    .where(eq(financePartiesTable.id, id)).limit(1);
  return { type: "finance.party", id, ownerId: row?.userId ?? FINANCE_OWNER_SENTINEL_NONE };
};

// Shared by both ledger-entry routes AND the repayment routes — a
// repayment's :id param names the PARENT ledger entry (see
// `POST /finance/entries/:id/repayments` below), not a repayment row of its
// own, so "who owns the entry" is the exact same ownership question either
// way.
const financeLedgerEntryResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(paramString(req.params.id), 10);
  if (!Number.isFinite(id)) return { type: "finance.ledger_entry", id: req.params.id, ownerId: FINANCE_OWNER_SENTINEL_NONE };
  const [row] = await db.select({ userId: financeLedgerEntriesTable.userId }).from(financeLedgerEntriesTable)
    .where(eq(financeLedgerEntriesTable.id, id)).limit(1);
  return { type: "finance.ledger_entry", id, ownerId: row?.userId ?? FINANCE_OWNER_SENTINEL_NONE };
};

// One throwaway `requireOwnership()` middleware per (resource type, action)
// pair, built ONCE at module load — same "cheap to build, build it once"
// posture `middlewares/auth.ts`'s `adminRoleCheck`/`devRoleCheck` already
// apply to their own throwaway engines. `action` is a real
// "product.resource.action" key (`finance.party.update`, ...) even though
// `requireOwnership()` itself doesn't validate the shape the way
// `requirePermission()` does — keeping the convention leaves room for a
// later phase to combine this with an RBAC rule on the same engine without
// renaming anything.
function requireFinancePartyOwnership(action: string) {
  return requireOwnership(action, financePartyResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => {
      res.status(404).json({ error: "Not found" });
    },
  });
}

function requireFinanceLedgerEntryOwnership(action: string) {
  return requireOwnership(action, financeLedgerEntryResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => {
      res.status(404).json({ error: "Entry not found" });
    },
  });
}

// ─── Route Integration Roadmap — Season E, Phase E1 (audit-only → enforcing
// promotion, book group) ────────────────────────────────────────────────────
// D7 gave this file's book/asset/goal/account/... routes an audit-only
// `authorize()` call (return value discarded, never blocks — see
// `auditFinanceOwnership()` and its own header below). That was the right
// call at the time (C27's "don't touch the SQL, just add visibility"
// posture), but it leaves these routes permanently invisible to
// `check-ownership-gate-coverage.ts` (154-route Season D baseline) even
// though every one of them already has a `ResourceRefBuilder` and a
// `PolicyEngine` sitting right there unused as an actual gate. This group
// (book: PUT .../:id, PUT .../:id/set-default, DELETE .../:id) is the first
// of that backlog promoted from audit-only to a real, blocking
// `requireOwnership()` — same `financePartyResource`/
// `financeLedgerEntryResource` router-level-middleware shape B1 already
// established above, same `onDeny` 404 body every book route already
// returned on its own pre-existing `and(eq(id), eq(userId))` miss (see each
// route below — this promotion changes WHEN the check runs and WHETHER a
// wrong-owner request reaches the handler at all, not what a caller
// observes on either outcome). `makeFinanceOwnerResource()` is defined
// further down this file as a plain hoisted `function` declaration
// (not a `const`), so calling it here — before its own textual position —
// is safe; only the *AuditEngine consts near it must NOT be reused as a
// blocking gate's engine, which is why `requireOwnership()` is used instead
// of `requirePolicy()` (it builds its own fresh single-rule engine
// internally — see that helper's own header).
const financeBookResource = makeFinanceOwnerResource("finance.book", financeBooksTable);
function requireFinanceBookOwnership(action: string) {
  return requireOwnership(action, financeBookResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => {
      res.status(404).json({ error: "Not found" });
    },
  });
}

// ─── Route Integration Roadmap — Season D, Phase D7 (consistency sweep,
// audit-trail wiring) ───────────────────────────────────────────────────────
// D2's triage confirmed 32 more of this file's `:id` routes are the exact
// same `and(eq(<table>.id, id), eq(<table>.userId, authUser.userId))` /
// `assertEntryOwnership()` shape B1 already covers for parties and ledger
// entries — genuinely safe, just never made it onto the PDP. Same posture
// `bulk.ts`'s Phase C27 already established for the bulk-family routes:
// this phase does NOT touch a single WHERE clause. It adds one `authorize()`
// call, purely for its audit side effect (`pepDecisionObserver` — a real,
// centrally-observable `AuthorizationDecision`), at the exact point each
// route's existing ownership check already runs. The pre-existing check is
// what actually decides the response; the PDP call's return value is
// discarded everywhere it's used below.
//
// `makeFinanceOwnerResource()` is `financePartyResource`/
// `financeLedgerEntryResource`'s own shape turned into a factory — one
// `{ id, userId }`-shaped Drizzle table in, one `ResourceRefBuilder` out.
// Re-reads the row's REAL owner fresh from the DB by :id, same "never trust
// a client-supplied ownerId" posture those two already establish (and the
// same reason this is a genuinely new query at each call site below, not a
// reuse of the route's own already-filtered check — an already-`userId`-
// filtered SELECT only ever returns "yes, mine" or "not found", which would
// make the audit trail tautological; re-reading unfiltered is what lets a
// real mismatch actually show up as a DENY, same as `bulk.ts`'s
// `auditBulkOwnership()` re-fetching candidates unfiltered for the same
// reason).
function makeFinanceOwnerResource(
  type: string,
  table: { id: any; userId: any },
): ResourceRefBuilder {
  return async (req: Request) => {
    const id = parseInt(paramString(req.params.id), 10);
    if (!Number.isFinite(id)) return { type, id: req.params.id, ownerId: FINANCE_OWNER_SENTINEL_NONE };
    const [row] = await db.select({ userId: table.userId }).from(table as any).where(eq(table.id, id)).limit(1);
    return { type, id, ownerId: row?.userId ?? FINANCE_OWNER_SENTINEL_NONE };
  };
}

// One resource builder per finance resource type — Season E, Phase E2
// promoted every route that used to hold an audit-only `*AuditEngine`
// alongside these to a real, blocking `requireOwnership()` gate (see the
// factories below), so those `*AuditEngine` consts have no remaining
// caller and have been removed rather than left as dead code (same rule
// D7/E1 already established: don't leave an unused construct behind once
// its last caller is gone).
const financeAccountResource = makeFinanceOwnerResource("finance.account", financeAccountsTable);
const financeAssetResource = makeFinanceOwnerResource("finance.asset", financeAssetsTable);
const financeGoalResource = makeFinanceOwnerResource("finance.goal", financeGoalsTable);
const financeRecurringRuleResource = makeFinanceOwnerResource("finance.recurring_rule", financeRecurringRulesTable);
const financeBudgetResource = makeFinanceOwnerResource("finance.budget", financeBudgetsTable);
const financeJournalEntryResource = makeFinanceOwnerResource("finance.journal_entry", financeJournalEntriesTable);
const financeReportScheduleResource = makeFinanceOwnerResource("finance.report_schedule", financeReportSchedulesTable);
const financeAmortizationResource = makeFinanceOwnerResource("finance.amortization", financeAmortizationTable);
const financeDepreciationResource = makeFinanceOwnerResource("finance.depreciation", financeDepreciationTable);

// ─── Route Integration Roadmap — Season E, Phase E2 (finance.ts remaining
// raw-SQL/audit-only groups, audit-only → enforcing) ────────────────────────
// Same promotion as E1's book group (see CHANGES_ROUTE_INTEGRATION_PHASE_E1.md),
// applied to every other resource family in this file that already has a
// `*Resource`/`*AuditEngine` pair declared above sitting unused as a real
// gate. No ordering trap here — every resource const these factories close
// over is declared above this point (lines ~346-380), and every route that
// uses them is registered below it, so there's no temporal-dead-zone risk
// the way the E1 book group had.
//
// Unlike the book/party factories above (fixed `onDeny`, one shared 404
// across every route of that type), several of these families have
// DIFFERENT pre-existing deny bodies per route within the same resource
// type (`finance.account`'s PUT vs DELETE; `finance.asset`'s PUT/DELETE
// "Not found" vs its depreciation sub-routes' "Asset not found") — so these
// take `onDeny` as a parameter, per OWNERSHIP_GATING_GUIDE.md's Step 3
// general template, rather than baking one in. Each call site below
// reproduces that ROUTE's own pre-existing deny body exactly — including
// the ones that silently no-op'd `{ success: true }` for a wrong-owner id
// before gating (goal/recurring/budget/report-schedule DELETE never had an
// explicit ownership-miss branch; their scoped `WHERE ... AND userId = ...`
// delete was already a no-op on a non-owned id, so the gate must reply the
// same inert way, not a new 404 — see the GUIDE's "silent no-op" deny shape).
function requireFinanceAssetOwnership(action: string, onDeny: (req: Request, res: Response) => void) {
  return requireOwnership(action, financeAssetResource, { onDecision: pepDecisionObserver, onDeny });
}
function requireFinanceGoalOwnership(action: string, onDeny: (req: Request, res: Response) => void) {
  return requireOwnership(action, financeGoalResource, { onDecision: pepDecisionObserver, onDeny });
}
function requireFinanceRecurringRuleOwnership(action: string, onDeny: (req: Request, res: Response) => void) {
  return requireOwnership(action, financeRecurringRuleResource, { onDecision: pepDecisionObserver, onDeny });
}
function requireFinanceBudgetOwnership(action: string, onDeny: (req: Request, res: Response) => void) {
  return requireOwnership(action, financeBudgetResource, { onDecision: pepDecisionObserver, onDeny });
}
function requireFinanceAccountOwnership(action: string, onDeny: (req: Request, res: Response) => void) {
  return requireOwnership(action, financeAccountResource, { onDecision: pepDecisionObserver, onDeny });
}
function requireFinanceJournalEntryOwnership(action: string) {
  return requireOwnership(action, financeJournalEntryResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => { res.status(404).json({ error: "Not found" }); },
  });
}
function requireFinanceReportScheduleOwnership(action: string, onDeny: (req: Request, res: Response) => void) {
  return requireOwnership(action, financeReportScheduleResource, { onDecision: pepDecisionObserver, onDeny });
}
function requireFinanceAmortizationOwnership(action: string) {
  return requireOwnership(action, financeAmortizationResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => { res.status(404).json({ error: "Not found" }); },
  });
}
function requireFinanceDepreciationOwnership(action: string) {
  return requireOwnership(action, financeDepreciationResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => { res.status(404).json({ error: "Not found" }); },
  });
}
// Shared "reply as if it already succeeded/didn't exist" deny, for the
// routes above whose pre-existing scoped delete already behaved this way.
function financeSilentSuccessDeny(_req: Request, res: Response): void {
  res.status(200).json({ success: true });
}
function financeNotFoundDeny(message: string) {
  return (_req: Request, res: Response): void => { res.status(404).json({ error: message }); };
}

// Entry-derived resources (attachments/receipt/invoice-lines) reuse
// `financeLedgerEntryResource`/`requireFinanceLedgerEntryOwnership()`
// directly — "who owns this attachment/receipt/invoice-line" IS "who owns
// the parent entry", the exact same question B1 already built a resource
// builder AND a blocking gate for. D7 originally gave this group its own
// audit-only `financeLedgerEntryAuditEngine`; Season E, Phase E1 promoted
// every entry-derived route to the real B1 gate instead (see
// `CHANGES_ROUTE_INTEGRATION_PHASE_E1.md`), so that audit-only engine has
// no remaining call sites and has been removed rather than left as dead
// code (Rule: don't leave an unused construct behind once its last caller
// is gone). `auditFinanceOwnership()` itself (D7's generic audit-only
// helper) is gone for the same reason as of Season E, Phase E2 — every
// route in this file that used to call it has been promoted to a real
// `requireOwnership()` gate above, so it had no remaining caller.

// ─── Parties ─────────────────────────────────────────────────────────────────

router.get("/finance/parties", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  res.json(await listParties(authUser.userId));
});

router.post("/finance/parties", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { name, contact, notes } = req.body as { name?: string; contact?: string; notes?: string };
  if (!name?.trim()) { res.status(400).json({ error: "name is required" }); return; }
  res.status(201).json(await createParty(authUser.userId, { name, contact, notes }));
});

router.put("/finance/parties/:id", requireAuth, requireFinancePartyOwnership("finance.party.update"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const { name, contact, notes } = req.body as { name?: string; contact?: string; notes?: string };
  const row = await updateParty(authUser.userId, id, { name, contact, notes });
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(row);
});

router.delete("/finance/parties/:id", requireAuth, requireFinancePartyOwnership("finance.party.delete"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  await deleteParty(authUser.userId, id);
  res.json({ success: true });
});

// ─── Ledger entries (Receivable/Payable/Borrowed/Lending/Investment/Expense/Income) ──

router.get("/finance/entries", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { kind, projectId, status, bookId } = req.query as Record<string, string>;
  const rows = await listEntries(authUser.userId, {
    kind, status,
    projectId: projectId ? parseInt(projectId, 10) : undefined,
    bookId: bookId ? parseInt(bookId, 10) : undefined,
  });
  res.json(rows.map(fmtEntry));
});

router.post("/finance/entries", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const b = req.body as Record<string, any>;
  if (!b.kind || !b.title?.trim()) { res.status(400).json({ error: "kind and title are required" }); return; }
  // `Number(b.amount) || 0` used to accept negative numbers and never rejected 0: such a row is never
  // journalled (postEntryJournal requires amount > 0), desyncs the books from the Finance list and
  // corrupts every downstream sum. POST /finance/entries/import already enforces amount > 0.
  const amountNum = Number(b.amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) { res.status(400).json({ error: "amount must be a positive number" }); return; }
  const row = await createEntry(authUser.userId, b, amountNum);
  res.status(201).json(fmtEntry(row));
});

router.put("/finance/entries/:id", requireAuth, requireFinanceLedgerEntryOwnership("finance.entry.update"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const result = await updateEntry(authUser.userId, id, req.body as Record<string, any>);
  if (result.status === "not_found") { res.status(404).json({ error: "Not found" }); return; }
  if (result.status === "invalid") { res.status(400).json({ error: result.error }); return; }
  res.json(fmtEntry(result.entry));
});

router.delete("/finance/entries/:id", requireAuth, requireFinanceLedgerEntryOwnership("finance.entry.delete"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid entry id" }); return; }
  // Ownership is confirmed before anything is deleted and again inside the cascade transaction (F5).
  if (!(await deleteEntry(authUser.userId, id))) { res.status(404).json({ error: "Entry not found" }); return; }
  res.json({ success: true });
});

// ─── Repayments (partial-payment history against an entry) ──────────────────

// Repayment rows as returned to clients: the internal idempotency key is not exposed.
function fmtRepayment(r: typeof financeRepaymentsTable.$inferSelect) {
  const { idempotencyKey: _idempotencyKey, ...rest } = r;
  return { ...rest, paidAt: iso(r.paidAt), createdAt: iso(r.createdAt) };
}

router.get("/finance/entries/:id/repayments", requireAuth, requireFinanceLedgerEntryOwnership("finance.repayment.read"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid entry id" }); return; }
  const rows = await listRepayments(authUser.userId, id);
  if (!rows) { res.status(404).json({ error: "Entry not found" }); return; }
  res.json(rows.map(fmtRepayment));
});

router.post("/finance/entries/:id/repayments", requireAuth, requireFinanceLedgerEntryOwnership("finance.repayment.create"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const entryId = parseInt(paramString(req.params.id), 10);
  const { amount, isInterest, notes, paidAt, idempotencyKey } = req.body as { amount?: number; isInterest?: boolean; notes?: string; paidAt?: string; idempotencyKey?: string };
  if (!amount || amount <= 0) { res.status(400).json({ error: "amount must be > 0" }); return; }

  // Optional retry protection: Idempotency-Key header (or body.idempotencyKey). The repayment row and
  // the balance/interest change commit atomically; see recordRepayment in finance/ledger/repayments.ts.
  const headerKey = req.header("Idempotency-Key");
  const rawKey = typeof headerKey === "string" && headerKey.trim() ? headerKey : idempotencyKey;
  if (rawKey !== undefined && (typeof rawKey !== "string" || !rawKey.trim() || rawKey.trim().length > 200)) {
    res.status(400).json({ error: "Idempotency-Key must be a non-empty string of at most 200 characters" });
    return;
  }

  const outcome = await addRepayment(authUser.userId, entryId, { amount, isInterest: !!isInterest, notes, paidAt, idempotencyKey: rawKey });
  if (outcome.status === "entry_not_found") { res.status(404).json({ error: "Entry not found" }); return; }
  if (outcome.status === "not_repayable") {
    res.status(400).json({ error: `Repayments aren't supported for '${outcome.kind}' entries — they're recorded as fully settled at creation.` });
    return;
  }
  if (outcome.status === "conflict") {
    res.status(409).json({ error: "Idempotency-Key was already used for a different repayment on this entry" });
    return;
  }
  if (outcome.status === "replayed") {
    res.setHeader("Idempotent-Replayed", "true");
    res.status(200).json(fmtRepayment(outcome.repayment));
    return;
  }
  res.status(201).json(fmtRepayment(outcome.repayment));
});

// ─── Attachments (receipts / invoices / screenshots on a ledger entry) ──────

// GET /finance/entries/:id/attachments — list (metadata only, no file bytes)
router.get("/finance/entries/:id/attachments", requireAuth, requireFinanceLedgerEntryOwnership("finance.entry.attachments.read"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const entryId = parseInt(paramString(req.params.id), 10);
  if (!Number.isFinite(entryId)) { res.status(400).json({ error: "Invalid entry id" }); return; }
  const rows = await listEntryAttachments(authUser.userId, entryId);
  if (!rows) { res.status(404).json({ error: "Entry not found" }); return; }
  res.json(rows.map(r => ({ ...r, uploadedAt: iso(r.uploadedAt) })));
});

// POST /finance/entries/:id/attachments — upload a receipt/invoice
// Body: { fileName, mimeType, note?, dataBase64 }. Only images and PDFs are accepted (see application/entries).
router.post("/finance/entries/:id/attachments", requireAuth, uploadBodyParser, requireFinanceLedgerEntryOwnership("finance.entry.attachments.create"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const entryId = parseInt(paramString(req.params.id), 10);
  if (!Number.isFinite(entryId)) { res.status(400).json({ error: "Invalid entry id" }); return; }
  const outcome = await uploadEntryAttachment(authUser.userId, entryId, req.body);
  if (outcome.status === "entry_not_found") { res.status(404).json({ error: "Entry not found" }); return; }
  if (outcome.status === "invalid") { res.status(400).json({ error: outcome.error }); return; }
  if (outcome.status === "too_large") {
    res.status(413).json({
      error: "File too large",
      code: "ATTACHMENT_TOO_LARGE",
      solution: `Attachments are limited to ${Math.floor(outcome.maxBytes / (1024 * 1024))}MB.`,
    });
    return;
  }
  res.status(201).json({ ...outcome.attachment, uploadedAt: iso(outcome.attachment.uploadedAt) });
});

// GET /finance/entries/:id/attachments/:attachmentId — fetch one (?raw=1 for raw bytes)
router.get("/finance/entries/:id/attachments/:attachmentId", requireAuth, requireFinanceLedgerEntryOwnership("finance.entry.attachments.read_one"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const entryId = parseInt(paramString(req.params.id), 10);
  const attachmentId = parseInt(paramString(req.params.attachmentId), 10);
  if (!Number.isFinite(entryId) || !Number.isFinite(attachmentId)) { res.status(400).json({ error: "Invalid id" }); return; }
  const outcome = await getEntryAttachment(authUser.userId, entryId, attachmentId);
  if (outcome.status === "entry_not_found") { res.status(404).json({ error: "Entry not found" }); return; }
  if (outcome.status === "attachment_not_found") { res.status(404).json({ error: "Attachment not found" }); return; }
  const row = outcome.attachment;

  if (req.query.raw === "1") {
    res.setHeader("Content-Type", row.mimeType);
    res.setHeader("Content-Disposition", `inline; filename="${row.fileName.replace(/"/g, "")}"`);
    res.send(Buffer.from(row.contentBase64, "base64"));
    return;
  }

  res.json({
    id: row.id, fileName: row.fileName, mimeType: row.mimeType, fileSizeBytes: row.fileSizeBytes,
    note: row.note, uploadedAt: iso(row.uploadedAt), dataBase64: row.contentBase64,
  });
});

// DELETE /finance/entries/:id/attachments/:attachmentId
router.delete("/finance/entries/:id/attachments/:attachmentId", requireAuth, requireFinanceLedgerEntryOwnership("finance.entry.attachments.delete"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const entryId = parseInt(paramString(req.params.id), 10);
  const attachmentId = parseInt(paramString(req.params.attachmentId), 10);
  if (!Number.isFinite(entryId) || !Number.isFinite(attachmentId)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!(await deleteEntryAttachment(authUser.userId, entryId, attachmentId))) { res.status(404).json({ error: "Entry not found" }); return; }
  res.json({ success: true });
});

router.post("/finance/entries/:id/receipt", requireAuth, requireFinanceLedgerEntryOwnership("finance.entry.receipt.create"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid entry id" }); return; }

  const outcome = await mintEntryReceiptLink(authUser.userId, id);
  if (outcome.status === "entry_not_found") { res.status(404).json({ error: "Entry not found" }); return; }
  if (outcome.status === "token_failed") { res.status(500).json({ error: "Could not generate a receipt link, please try again" }); return; }

  res.json({ token: outcome.token, url: outcome.url });
});

// DELETE /finance/entries/:id/receipt — revoke the public link (any
// previously shared URL stops working; a fresh POST mints a new one)
router.delete("/finance/entries/:id/receipt", requireAuth, requireFinanceLedgerEntryOwnership("finance.entry.receipt.delete"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid entry id" }); return; }
  if (!(await revokeEntryReceiptLink(authUser.userId, id))) { res.status(404).json({ error: "Entry not found" }); return; }
  res.json({ success: true });
});

// GET /finance/receipt/:token — public, no auth: read-only receipt data
router.get("/finance/receipt/:token", requirePublicAudit("finance_receipt.view", { onDecision: pepDecisionObserver }), async (req, res): Promise<void> => {
  const token = paramString(req.params.token);
  if (!token) { res.status(400).json({ error: "Missing token" }); return; }
  const found = await findByReceiptToken(token);
  if (!found) { res.status(404).json({ error: "This receipt link is invalid or has been revoked." }); return; }
  res.json(fmtPublicReceipt(found.entry, found.partyName, found.issuedBy, found.lines));
});

// GET /finance/receipt/:token/pdf — public, no auth: the same receipt as a PDF
router.get("/finance/receipt/:token/pdf", requirePublicAudit("finance_receipt.pdf", { onDecision: pepDecisionObserver }), async (req, res): Promise<void> => {
  const token = paramString(req.params.token);
  if (!token) { res.status(400).json({ error: "Missing token" }); return; }
  const found = await findByReceiptToken(token);
  if (!found) { res.status(404).json({ error: "This receipt link is invalid or has been revoked." }); return; }
  renderReceiptPdf(found, res);
});

// ─── Assets (Cash, Bank, Online Wallets, Mutual Funds, Locked Funds, Other) ──

router.get("/finance/assets", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { assetType } = req.query as Record<string, string>;
  const assets = await listAssets(authUser.userId, assetType);
  res.json(assets.map(({ asset, owners }) => ({ ...fmtAsset(asset), owners })));
});

router.post("/finance/assets", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const b = req.body as Record<string, any>;
  if (!b.assetType || !b.name?.trim()) { res.status(400).json({ error: "assetType and name are required" }); return; }
  const { asset, owners } = await createAsset(authUser.userId, b);
  res.status(201).json({ ...fmtAsset(asset), owners });
});

router.put("/finance/assets/:id", requireAuth, requireFinanceAssetOwnership("finance.asset.update", financeNotFoundDeny("Not found")), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const outcome = await updateAsset(authUser.userId, id, req.body as Record<string, any>);
  if (outcome.status === "invalid") { res.status(400).json({ error: outcome.error }); return; }
  if (outcome.status === "not_found") { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ...fmtAsset(outcome.asset), owners: outcome.owners });
});

router.delete("/finance/assets/:id", requireAuth, requireFinanceAssetOwnership("finance.asset.delete", financeNotFoundDeny("Not found")), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid asset id" }); return; }
  if (!(await deleteAsset(authUser.userId, id))) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ success: true });
});

// ─── Investments — per-project rollup (Invested / Spent / Earned / PnL) ─────

router.get("/finance/investments", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  res.json(await getProjectInvestments(authUser.userId));
});

// ─── Dashboard summary ───────────────────────────────────────────────────────

router.get("/finance/summary", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const result = await getFinanceSummary(authUser.userId);
  res.json({ ...result, upcoming: result.upcoming.map(fmtEntry) });
});

// ─── Net Worth (breakdown + trend snapshots) ────────────────────────────────

router.get("/finance/net-worth", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  res.json(await computeNetWorthBreakdown(authUser.userId));
});

router.get("/finance/net-worth/history", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const months = parseInt((req.query.months as string) ?? "12", 10) || 12;
  const rows = await listNetWorthHistory(authUser.userId, months);
  res.json(rows);
});

// Manual "snapshot now" button — same formula/table the monthly cron uses
// (lib/finance-networth-cron.ts), replaces the current month's point.
router.post("/finance/net-worth/snapshot", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  await snapshotNetWorth(authUser.userId);
  const rows = await listNetWorthHistory(authUser.userId, 12);
  res.status(201).json(rows[rows.length - 1] ?? null);
});

// ─── Financial Goals ─────────────────────────────────────────────────────────

router.get("/finance/goals", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  res.json(await listGoals(authUser.userId));
});

router.post("/finance/goals", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { title, goalType, targetAmount, currentAmount, currency, targetDate, linkedAssetId, notes } = req.body as {
    title?: string; goalType?: string; targetAmount?: number; currentAmount?: number;
    currency?: string; targetDate?: string; linkedAssetId?: number | null; notes?: string;
  };
  if (!title?.trim() || !targetAmount || targetAmount <= 0) { res.status(400).json({ error: "title and a positive targetAmount are required" }); return; }
  res.status(201).json(await createGoal(authUser.userId, { title, goalType, targetAmount, currentAmount, currency, targetDate, linkedAssetId, notes }));
});

router.put("/finance/goals/:id", requireAuth, requireFinanceGoalOwnership("finance.goal.update", financeNotFoundDeny("Goal not found")), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const { title, goalType, targetAmount, currentAmount, currency, targetDate, linkedAssetId, status, notes } = req.body as {
    title?: string; goalType?: string; targetAmount?: number; currentAmount?: number;
    currency?: string; targetDate?: string | null; linkedAssetId?: number | null; status?: string; notes?: string;
  };
  const goal = await updateGoal(authUser.userId, id, { title, goalType, targetAmount, currentAmount, currency, targetDate, linkedAssetId, status, notes });
  if (!goal) { res.status(404).json({ error: "Goal not found" }); return; }
  res.json(goal);
});

// Manual contribution — adds to currentAmount and auto-flags 'achieved' once
// the target is reached. Not available on goals linked to an asset, since
// their currentAmount is derived from the asset instead (see syncGoalProgress).
router.post("/finance/goals/:id/contribute", requireAuth, requireFinanceGoalOwnership("finance.goal.contribute", financeNotFoundDeny("Goal not found")), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const { amount } = req.body as { amount?: number };
  if (!amount || amount <= 0) { res.status(400).json({ error: "amount must be positive" }); return; }
  const result = await contributeToGoal(authUser.userId, id, amount);
  if (result.status === "not_found") { res.status(404).json({ error: "Goal not found" }); return; }
  if (result.status === "linked_asset") { res.status(400).json({ error: "This goal tracks a linked asset automatically — update the asset instead" }); return; }
  res.json(result.goal);
});

router.delete("/finance/goals/:id", requireAuth, requireFinanceGoalOwnership("finance.goal.delete", financeSilentSuccessDeny), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  await deleteGoal(authUser.userId, id);
  res.json({ success: true });
});

// ─── Projections ──────────────────────────────────────────────────────────

router.get("/finance/projections", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  res.json(await getFinanceProjections(authUser.userId));
});

// ─── Recurring rules ─────────────────────────────────────────────────────────

router.get("/finance/recurring", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const rows = await listRecurringRules(authUser.userId);
  res.json(rows.map(r => ({
    ...r,
    startDate: iso(r.startDate), nextRunDate: iso(r.nextRunDate), endDate: iso(r.endDate),
    lastRunAt: iso(r.lastRunAt), createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt),
    active: !!r.active,
  })));
});

router.post("/finance/recurring", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const b = req.body as Record<string, any>;
  if (!b.kind || !b.title?.trim() || !b.amount) { res.status(400).json({ error: "kind, title and amount are required" }); return; }
  const row = await createRecurringRule(authUser.userId, b as Parameters<typeof createRecurringRule>[1]);
  res.status(201).json(row);
});

router.put("/finance/recurring/:id", requireAuth, requireFinanceRecurringRuleOwnership("finance.recurring_rule.update", financeNotFoundDeny("Not found")), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const row = await updateRecurringRule(authUser.userId, id, req.body as Record<string, any>);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(row);
});

router.delete("/finance/recurring/:id", requireAuth, requireFinanceRecurringRuleOwnership("finance.recurring_rule.delete", financeSilentSuccessDeny), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  await deleteRecurringRule(authUser.userId, id);
  res.json({ success: true });
});

// Manual trigger — mostly for verifying a rule works right after creating it,
// instead of waiting for the next 00:15 sweep.
router.post("/finance/recurring/run-now", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  // Scoped to the caller: only this user's due rules run and are counted.
  const result = await runRecurringNow(authUser.userId);
  res.json(result);
});

// ─── Budgets (monthly cap per expense category) ──────────────────────────────

router.get("/finance/budgets", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  res.json(await listBudgetsWithSpent(authUser.userId));
});

router.post("/finance/budgets", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { category, monthlyLimit, notes } = req.body as { category?: string; monthlyLimit?: number; notes?: string };
  if (!category?.trim() || !monthlyLimit) { res.status(400).json({ error: "category and monthlyLimit are required" }); return; }
  res.status(201).json(await upsertBudget(authUser.userId, { category, monthlyLimit, notes }));
});

router.delete("/finance/budgets/:id", requireAuth, requireFinanceBudgetOwnership("finance.budget.delete", financeSilentSuccessDeny), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  await deleteBudget(authUser.userId, id);
  res.json({ success: true });
});

// ─── Currency rates ──────────────────────────────────────────────────────────

router.get("/finance/currencies", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const rows = await listCurrencyRates(authUser.userId);
  res.json([{ currency: "BDT", rateToBase: 1, updatedAt: null }, ...rows.map(r => ({ ...r, updatedAt: iso(r.updatedAt) }))]);
});

router.put("/finance/currencies/:currency", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const currency = paramString(req.params.currency).toUpperCase();
  if (currency === "BDT") { res.status(400).json({ error: "BDT is the fixed base currency (rate = 1)" }); return; }
  const { rateToBase } = req.body as { rateToBase?: number };
  if (!rateToBase || rateToBase <= 0) { res.status(400).json({ error: "rateToBase must be > 0" }); return; }
  res.json(await upsertCurrencyRate(authUser.userId, currency, rateToBase));
});

// ─── Export (CSV / PDF) ───────────────────────────────────────────────────────

router.get("/finance/export", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { kind, format = "csv" } = req.query as Record<string, string>;
  const rows = await getFinanceExportRows(authUser.userId, kind);

  const stamp = new Date().toISOString().slice(0, 10);

  if (format === "pdf") {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="ayzen-finance-${kind ?? "all"}-${stamp}.pdf"`);
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    doc.pipe(res);
    doc.fontSize(16).text(`AYZEN Finance Export${kind ? ` — ${kind}` : ""}`, { align: "left" });
    doc.fontSize(10).fillColor("#555").text(`Generated: ${new Date().toISOString()}`);
    doc.text(`Total entries: ${rows.length}`);
    doc.moveDown(1);
    doc.fillColor("#000");

    const colX = { date: 40, kind: 110, title: 190, amount: 400, status: 470 };
    doc.fontSize(9).font("Helvetica-Bold");
    doc.text("Date", colX.date, doc.y, { continued: false });
    doc.text("Kind", colX.kind, doc.y - doc.currentLineHeight());
    doc.text("Title", colX.title, doc.y - doc.currentLineHeight());
    doc.text("Amount", colX.amount, doc.y - doc.currentLineHeight());
    doc.text("Status", colX.status, doc.y - doc.currentLineHeight());
    doc.moveDown(0.5);
    doc.font("Helvetica");

    for (const r of rows) {
      if (doc.y > 760) doc.addPage();
      const y = doc.y;
      doc.fontSize(8);
      doc.text(r.occurredDate.toISOString().slice(0, 10), colX.date, y, { width: 65 });
      doc.text(r.kind, colX.kind, y, { width: 75 });
      doc.text(r.title.slice(0, 40), colX.title, y, { width: 200 });
      doc.text(`${r.currency} ${r.amount.toLocaleString()}`, colX.amount, y, { width: 65 });
      doc.text(r.status, colX.status, y, { width: 60 });
      doc.moveDown(0.6);
    }
    doc.end();
    return;
  }

  const csv = toCsv(
    rows.map(r => ({
      date: r.occurredDate.toISOString().slice(0, 10),
      kind: r.kind, title: r.title, amount: r.amount, currency: r.currency,
      category: r.category ?? "", dueDate: r.dueDate ? r.dueDate.toISOString().slice(0, 10) : "",
      status: r.status, interestRate: r.interestRate ?? "", notes: r.notes ?? "",
    })),
    ["date", "kind", "title", "amount", "currency", "category", "dueDate", "status", "interestRate", "notes"],
  );
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="ayzen-finance-${kind ?? "all"}-${stamp}.csv"`);
  res.send(csv);
});

// ─── Bulk import (CSV) ────────────────────────────────────────────────────────
// Expected header: kind,title,amount,currency,category,dueDate,status,interestRate,notes

router.post("/finance/entries/import", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { csv, bookId } = req.body as { csv?: string; bookId?: number };
  if (!csv?.trim()) { res.status(400).json({ error: "csv text is required" }); return; }
  res.json(await importEntriesCsv(authUser.userId, csv, bookId));
});

// ─── Analytics (charts) ───────────────────────────────────────────────────────

router.get("/finance/analytics", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  res.json(await getFinanceAnalytics(authUser.userId));
});

// ─── Smart Alerts & Insights ─────────────────────────────────────────────────
// One endpoint that rolls up everything the dashboard's "at a glance" widget
// needs: overdue/upcoming alerts, budget-overrun flags, a rough cashflow
// forecast (ledger due-dates + projected recurring-rule occurrences), and a
// simple 0–100 "financial health" score. All heuristic, computed on read —
// no new tables, no background job.

router.get("/finance/insights", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  res.json(await getFinanceInsights(authUser.userId));
});

// ─── Accounting: Chart of Accounts / Journal / Reports / Amortization ───────
// See lib/finance-accounting.ts for the seeding + posting engine. Finance
// entries and repayments above already auto-post into this layer; everything
// below is the direct CRUD/reporting surface the Accounting UI talks to.

function fmtAccount(a: typeof financeAccountsTable.$inferSelect) {
  return { ...a, createdAt: iso(a.createdAt), updatedAt: iso(a.updatedAt) };
}
function fmtJournalEntry(je: typeof financeJournalEntriesTable.$inferSelect, lines: (typeof financeJournalLinesTable.$inferSelect)[]) {
  return { ...je, date: iso(je.date), createdAt: iso(je.createdAt), lines };
}

router.get("/finance/accounts", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { bookId } = req.query as Record<string, string>;
  const rows = await listAccounts(authUser.userId, bookId ? parseInt(bookId, 10) : undefined);
  res.json(rows.map(fmtAccount));
});

router.post("/finance/accounts", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { code, name, type, normalBalance, parentId, bookId } = req.body as { code?: string; name?: string; type?: string; normalBalance?: string; parentId?: number; bookId?: number };
  if (!code?.trim() || !name?.trim() || !type) { res.status(400).json({ error: "code, name and type are required" }); return; }
  const outcome = await createAccount(authUser.userId, { code, name, type, normalBalance, parentId, bookId });
  if (outcome.status === "duplicate_code") { res.status(400).json({ error: "Account code already exists" }); return; }
  res.status(201).json(fmtAccount(outcome.account));
});

router.put("/finance/accounts/:id", requireAuth, requireFinanceAccountOwnership("finance.account.update", financeNotFoundDeny("Not found or is a system account")), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const row = await updateAccount(authUser.userId, id, req.body as Record<string, any>);
  if (!row) { res.status(404).json({ error: "Not found or is a system account" }); return; }
  res.json(fmtAccount(row));
});

router.delete("/finance/accounts/:id", requireAuth, requireFinanceAccountOwnership("finance.account.delete", financeNotFoundDeny("Not found")), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const outcome = await deleteAccount(authUser.userId, id);
  if (outcome.status === "not_found") { res.status(404).json({ error: "Not found" }); return; }
  if (outcome.status === "system_account") { res.status(400).json({ error: "System accounts can't be deleted" }); return; }
  if (outcome.status === "has_activity") { res.status(400).json({ error: "Account has journal activity and can't be deleted" }); return; }
  res.json({ success: true });
});

// ─── Journal ─────────────────────────────────────────────────────────────────

router.get("/finance/journal", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { accountId, bookId } = req.query as Record<string, string>;
  const rows = await listJournal(authUser.userId, {
    accountId: accountId ? parseInt(accountId, 10) : undefined,
    bookId: bookId ? parseInt(bookId, 10) : undefined,
  });
  res.json(rows.map(r => fmtJournalEntry(r.entry, r.lines)));
});

router.get("/finance/journal/:id", requireAuth, requireFinanceJournalEntryOwnership("finance.journal_entry.read"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const found = await getJournalEntry(authUser.userId, id);
  if (!found) { res.status(404).json({ error: "Not found" }); return; }
  res.json(fmtJournalEntry(found.entry, found.lines));
});

router.post("/finance/journal", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { memo, date, lines, bookId } = req.body as { memo?: string; date?: string; lines?: { accountId: number; debit: number; credit: number }[]; bookId?: number };
  if (!memo?.trim() || !Array.isArray(lines) || lines.length < 2) { res.status(400).json({ error: "memo and at least 2 lines are required" }); return; }
  const result = await createManualJournal(authUser.userId, { memo, date, lines, bookId });
  if (!result.ok) { res.status(400).json({ error: result.error }); return; }
  res.status(201).json(fmtJournalEntry(result.entry, result.lines));
});

router.delete("/finance/journal/:id", requireAuth, requireFinanceJournalEntryOwnership("finance.journal_entry.delete"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const outcome = await deleteManualJournal(authUser.userId, id);
  if (outcome === "not_found") { res.status(404).json({ error: "Not found" }); return; }
  if (outcome === "not_manual") { res.status(400).json({ error: "Only manual entries can be deleted" }); return; }
  res.json({ success: true });
});

// ─── Reports ─────────────────────────────────────────────────────────────────

router.get("/finance/reports/trial-balance", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  res.json(await getTrialBalanceReport(authUser.userId, req.query as Record<string, string>));
});

router.get("/finance/reports/balance-sheet", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  res.json(await getBalanceSheetReport(authUser.userId, req.query as Record<string, string>));
});

router.get("/finance/reports/income-statement", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  res.json(await getIncomeStatementReport(authUser.userId, req.query as Record<string, string>));
});

router.get("/finance/reports/cash-flow", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  res.json(await getCashFlowReport(authUser.userId, req.query as Record<string, string>));
});

// ─── Custom report builder (Phase 4 — Advanced reporting) ──────────────────
// A pivot over the ledger-entry tracker (not the double-entry Journal —
// that's what trial-balance/balance-sheet/income-statement already cover):
// pick a groupBy dimension, optional filters, get grouped totals back, in
// the user's base currency (see getRateMap/toBase above) so entries in
// different original currencies still roll up into one comparable number —
// this doubles as the "multi-currency consolidated reporting" item.
// Supports format=json (default) | csv | pdf.
router.get("/finance/reports/custom", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const q = req.query as Record<string, string>;
  const format = q.format === "csv" || q.format === "pdf" ? q.format : "json";

  // PHASE 5: metered action ryft.report_export. Only the actual export
  // formats (CSV/PDF) are metered — viewing the report as JSON in the app
  // is the "basic ledger" functionality §5 keeps free. Checked here, before
  // any work is done, so a user who can't afford it gets a 402 instead of a
  // built-then-discarded report.
  if (format !== "json") {
    const balanceCheck = await hasCreditBalance(authUser.userId, "ryft.report_export");
    if (!balanceCheck.ok) {
      res.status(402).json({
        error: "Out of credits",
        code: "OUT_OF_CREDITS",
        action: balanceCheck.action.key,
        label: balanceCheck.action.label,
        cost: balanceCheck.action.cost,
        balance: balanceCheck.balance,
        topUp: { method: "POST", url: "/api/credits/purchase" },
      });
      return;
    }
  }

  const result = await getCustomFinanceReport(authUser.userId, q);

  if (format === "csv") {
    const csv = toCsv(
      result.groups.map(g => ({ [result.groupBy]: g.label, count: g.count, total_bdt: g.total })),
      [result.groupBy, "count", "total_bdt"],
    );
    // Charge-on-success: the export is actually built at this point, so the
    // user is only billed once the CSV genuinely exists — see file header
    // in services/credit-meter.ts.
    await chargeCredits(authUser.userId, "ryft.report_export");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="finance-report-${result.groupBy}.csv"`);
    res.send(csv);
    return;
  }
  if (format === "pdf") {
    await chargeCredits(authUser.userId, "ryft.report_export");
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="finance-report-${result.groupBy}.pdf"`);
    doc.pipe(res);
    renderCustomReportPdf(doc, result);
    doc.end();
    return;
  }
  res.json(result);
});

function renderCustomReportPdf(doc: PDFKit.PDFDocument, result: CustomFinanceReport): void {
  doc.fontSize(18).text("Custom Finance Report", { align: "left" });
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor("#555")
    .text(`Grouped by: ${result.groupBy}${result.from ? `  ·  From ${result.from}` : ""}${result.to ? `  ·  To ${result.to}` : ""}`);
  doc.moveDown(1);
  doc.fillColor("#000").fontSize(11);
  for (const g of result.groups) {
    doc.text(`${g.label}`, { continued: true, width: 300 });
    doc.text(`  ${g.count} entries`, { continued: true });
    doc.text(`  BDT ${g.total.toLocaleString()}`, { align: "right" });
  }
  doc.moveDown(1);
  doc.fontSize(13).text(`Grand Total: BDT ${result.grandTotal.toLocaleString()}  (${result.entryCount} entries)`);
}

// ─── Scheduled report delivery (Phase 4 — monthly P&L auto-email, formalized) ─
// The daily digest (finance-notify.ts) is a lightweight activity rollup;
// this is the "real" version — a formal PDF of an actual report (Income
// Statement / Balance Sheet / Trial Balance / Cash Flow) delivered on a
// fixed day of the month. See finance-report-schedule-cron.ts for the sweep
// that actually sends these.
router.get("/finance/report-schedules", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const rows = await listReportSchedules(authUser.userId);
  res.json(rows.map(r => ({ ...r, lastSentAt: iso(r.lastSentAt), createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt) })));
});

router.post("/finance/report-schedules", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { bookId, reportType, dayOfMonth } = req.body as { bookId?: number; reportType?: string; dayOfMonth?: number };
  if (reportType && !REPORT_SCHEDULE_TYPES.includes(reportType)) { res.status(400).json({ error: `reportType must be one of ${REPORT_SCHEDULE_TYPES.join(", ")}` }); return; }
  res.status(201).json(await createReportSchedule(authUser.userId, { bookId, reportType, dayOfMonth }));
});

router.put("/finance/report-schedules/:id", requireAuth, requireFinanceReportScheduleOwnership("finance.report_schedule.update", financeNotFoundDeny("Not found")), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const { active, dayOfMonth } = req.body as { active?: boolean; dayOfMonth?: number };
  const row = await updateReportSchedule(authUser.userId, id, { active, dayOfMonth });
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(row);
});

router.delete("/finance/report-schedules/:id", requireAuth, requireFinanceReportScheduleOwnership("finance.report_schedule.delete", financeSilentSuccessDeny), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  await deleteReportSchedule(authUser.userId, id);
  res.json({ success: true });
});

// ─── Loan Amortization ───────────────────────────────────────────────────────

router.get("/finance/entries/:id/amortization", requireAuth, requireFinanceLedgerEntryOwnership("finance.entry.amortization.read"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const entryId = parseInt(paramString(req.params.id), 10);
  const rows = await listAmortization(authUser.userId, entryId);
  if (!rows) { res.status(404).json({ error: "Entry not found" }); return; }
  res.json(rows);
});

router.post("/finance/entries/:id/amortization/generate", requireAuth, requireFinanceLedgerEntryOwnership("finance.entry.amortization.generate"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const entryId = parseInt(paramString(req.params.id), 10);
  const { termMonths } = req.body as { termMonths?: number };
  const months = Math.floor(Number(termMonths));
  if (!months || months < 1) { res.status(400).json({ error: "termMonths must be at least 1" }); return; }

  const outcome = await generateAmortization(authUser.userId, entryId, months);
  if (outcome.status === "not_found") { res.status(404).json({ error: "Entry not found" }); return; }
  if (outcome.status === "wrong_kind") { res.status(400).json({ error: "Amortization only applies to borrowed/lending entries" }); return; }
  res.status(201).json(outcome.rows);
});

router.put("/finance/amortization/:id/pay", requireAuth, requireFinanceAmortizationOwnership("finance.amortization.pay"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  // Claim, repayments and balance change are one transaction; a repeat or concurrent request for an
  // installment that is already paid returns it unchanged (see payAmortizationInstallment).
  const result = await payAmortizationInstallment(id, authUser.userId);
  if (result.status === "not_found") { res.status(404).json({ error: "Not found" }); return; }
  if (result.status === "entry_not_found") { res.status(404).json({ error: "Entry not found" }); return; }
  const { row } = result;
  res.json({ ...row, dueDate: iso(row.dueDate), paidAt: iso(row.paidAt), createdAt: iso(row.createdAt) });
});

// ─── Depreciation (fixed assets) ─────────────────────────────────────────────

router.get("/finance/assets/:id/depreciation", requireAuth, requireFinanceAssetOwnership("finance.asset.depreciation.read", financeNotFoundDeny("Asset not found")), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const assetId = parseInt(paramString(req.params.id), 10);
  const rows = await listDepreciation(authUser.userId, assetId);
  if (!rows) { res.status(404).json({ error: "Asset not found" }); return; }
  res.json(rows);
});

router.post("/finance/assets/:id/depreciation/generate", requireAuth, requireFinanceAssetOwnership("finance.asset.depreciation.generate", financeNotFoundDeny("Asset not found")), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const assetId = parseInt(paramString(req.params.id), 10);
  const { method, usefulLifeMonths, salvageValue, startDate } = req.body as {
    method?: "straight_line" | "declining_balance"; usefulLifeMonths?: number; salvageValue?: number; startDate?: string;
  };
  if (method !== "straight_line" && method !== "declining_balance") { res.status(400).json({ error: "method must be straight_line or declining_balance" }); return; }
  const months = Math.floor(Number(usefulLifeMonths));
  if (!months || months < 1) { res.status(400).json({ error: "usefulLifeMonths must be at least 1" }); return; }

  const rows = await generateDepreciation(authUser.userId, assetId, { method, months, salvageValue, startDate });
  if (!rows) { res.status(404).json({ error: "Asset not found" }); return; }
  res.status(201).json(rows);
});

router.put("/finance/depreciation/:id/post", requireAuth, requireFinanceDepreciationOwnership("finance.depreciation.post"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = parseInt(paramString(req.params.id), 10);
  const outcome = await postDepreciationPeriod(authUser.userId, id);
  if (outcome.status === "not_found") { res.status(404).json({ error: "Not found" }); return; }
  if (outcome.status === "asset_not_found") { res.status(404).json({ error: "Asset not found" }); return; }
  if (outcome.status === "journal_failed") { res.status(500).json({ error: "Could not post the depreciation journal; the period was not marked posted. Please retry." }); return; }
  const { row } = outcome;
  res.json({ ...row, periodDate: iso(row.periodDate), postedAt: iso(row.postedAt), createdAt: iso(row.createdAt) });
});

// ─── Invoicing (line items on top of a 'receivable' entry) ──────────────────

router.get("/finance/entries/:id/invoice-lines", requireAuth, requireFinanceLedgerEntryOwnership("finance.entry.invoice_lines.read"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const entryId = parseInt(paramString(req.params.id), 10);
  const lines = await listInvoiceLines(authUser.userId, entryId);
  if (!lines) { res.status(404).json({ error: "Entry not found" }); return; }
  res.json(lines.map(l => ({ ...l, createdAt: iso(l.createdAt) })));
});

// PUT replaces the full line set — simplest correct model for an invoice editor (add/remove/reorder
// lines, save once). application/entries recomputes entry.amount and posts a journal adjustment for the
// delta, leaving repayment/interest journals intact.
router.put("/finance/entries/:id/invoice-lines", requireAuth, requireFinanceLedgerEntryOwnership("finance.entry.invoice_lines.update"), async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const entryId = parseInt(paramString(req.params.id), 10);
  const { lines } = req.body as { lines?: InvoiceLineInput[] };
  const outcome = await replaceInvoiceLines(authUser.userId, entryId, lines);
  if (outcome.status === "entry_not_found") { res.status(404).json({ error: "Entry not found" }); return; }
  if (outcome.status === "invalid") { res.status(400).json({ error: outcome.error }); return; }
  res.json({ entry: outcome.entry, lines: outcome.lines.map(l => ({ ...l, createdAt: iso(l.createdAt) })) });
});

// ─── AI Assist (Phase 2 — Smart Entry) ───────────────────────────────────────
// All parsing/categorization/anomaly/recurring-detection logic lives in
// lib/finance-ai.ts and is deterministic/DB-driven; Groq (if configured) is
// only ever used to phrase a sentence around numbers already computed here,
// never to invent them. See finance-quick-add.tsx for the widget these feed.

router.post("/finance/ai/quick-entry/preview", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { text, currency } = req.body as { text?: string; currency?: string };
  if (!text?.trim()) { res.status(400).json({ error: "text is required" }); return; }

  res.json({ drafts: await previewQuickEntries(authUser.userId, text, currency) });
});

router.post("/finance/ai/quick-entry/commit", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { entries } = req.body as { entries?: QuickEntryCommitInput[] };
  if (!Array.isArray(entries) || entries.length === 0) { res.status(400).json({ error: "entries array is required" }); return; }

  const created = (await commitQuickEntries(authUser.userId, entries)).map(fmtEntry);
  if (!created.length) { res.status(400).json({ error: "No valid entries to commit" }); return; }
  res.status(201).json({ created });
});

router.post("/finance/ai/query", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { question } = req.body as { question?: string };
  if (!question?.trim()) { res.status(400).json({ error: "question is required" }); return; }
  const result = await answerFinanceQuery(authUser.userId, question);
  res.json(result);
});

router.get("/finance/ai/anomalies", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const flags = await detectAnomalies(authUser.userId);
  res.json({ flags });
});

router.get("/finance/ai/recurring-suggestions", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const candidates = await detectRecurringCandidates(authUser.userId);
  res.json({ candidates });
});

// ─── Receipt scan (Tesseract.js OCR — free, runs locally, no API key) ───────

router.post("/finance/ai/receipt-scan", requireAuth, uploadBodyParser, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { imageBase64, currency } = req.body as { imageBase64?: string; currency?: string };
  if (!imageBase64) { res.status(400).json({ error: "imageBase64 is required" }); return; }
  if (imageBase64.length > MAX_ATTACHMENT_BYTES * 1.4) { res.status(413).json({ error: "Image too large" }); return; }

  try {
    res.json(await scanReceipt(authUser.userId, imageBase64, currency));
  } catch (err: any) {
    res.status(500).json({ error: "Couldn't read that receipt — try a clearer photo.", detail: err?.message });
  }
});

// ─── Bank / mobile-wallet SMS auto-entry (free — no SMS gateway) ────────────
// The user forwards bank/bKash/Nagad-style SMS via a free forwarding app
// (SMS Forwarder, Tasker, Macrodroid, etc.) pointed at the URL below —
// no paid SMS gateway or credit card involved anywhere in this flow.

router.get("/finance/ai/sms-webhook-token", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const info = await getSmsWebhookInfo(authUser.userId);
  if (!info) { res.status(500).json({ error: "Couldn't generate a webhook token" }); return; }
  res.json(info);
});

router.post("/finance/ai/sms-webhook-token/rotate", requireAuth, async (req, res): Promise<void> => {
  const authUser = getRequestUser(req);
  if (!authUser) { res.status(401).json({ error: "Unauthorized" }); return; }
  const info = await rotateSmsWebhookInfo(authUser.userId);
  if (!info) { res.status(500).json({ error: "Couldn't rotate the webhook token" }); return; }
  res.json(info);
});

// Unauthenticated by design — possession of the unguessable :token in the
// URL is the only credential, same model as GET /finance/receipt/:token.
// Most SMS-forwarding apps can't attach a Bearer header, only a plain POST.
router.post("/finance/ai/sms-webhook/:token", requirePublicAudit("finance_sms_webhook.ingest", { onDecision: pepDecisionObserver }), async (req, res): Promise<void> => {
  const token = paramString(req.params.token);
  const { text } = req.body as { text?: string };
  if (!text?.trim()) { res.status(400).json({ error: "text is required" }); return; }

  const outcome = await ingestSmsWebhook(token, text, (userId, row, draftKind) => {
    createNotification(
      userId,
      "finance_sms_entry_created",
      `📩 Logged from SMS — ${row.title}`,
      `${draftKind === "income" ? "Received" : "Spent"} ${row.currency} ${row.amount.toLocaleString()}. Auto-created from a forwarded SMS — double-check it's right.`,
      { entryId: row.id },
    ).catch(() => {});
  });
  if (outcome.status === "unknown_token") { res.status(404).json({ error: "Unknown webhook token" }); return; }
  if (outcome.status === "unparsed") { res.status(200).json({ created: false, reason: "Couldn't confidently parse an amount/direction from this SMS." }); return; }
  if (outcome.status === "duplicate") { res.status(200).json({ created: false, reason: "Looks like a duplicate of an existing entry.", duplicate: outcome.duplicate }); return; }
  res.status(201).json({ created: true, entry: fmtEntry(outcome.entry) });
});

export default router;
