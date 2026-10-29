import { eq } from "drizzle-orm";
import { db, financeLedgerEntriesTable, usersTable } from "@workspace/db";
import { postEntryJournal } from "../ledger/journal";
import { resolveBookId } from "../ledger/books";
import { notifyEntryCreated } from "../notifications/notify";
import {
  parseQuickEntryText,
  findDuplicateEntry,
  extractReceiptFields,
  parseBankSms,
  ensureSmsWebhookToken,
  rotateSmsWebhookToken,
  type QuickEntryDraft,
} from "../ai/finance-ai";

// Orchestration for the /finance/ai routes. Moved unchanged from routes/finance.ts (FIN-WP-2b).
// Parsing, categorization, anomaly and recurring detection stay in finance/ai/finance-ai.ts
// (the three read-only routes query/anomalies/recurring-suggestions call it directly and hold no
// orchestration). The routes keep HTTP validation, the upload body parser and response formatting.

export async function previewQuickEntries(userId: number, text: string, currency?: string) {
  const drafts = await parseQuickEntryText(userId, text, currency || "BDT");
  return Promise.all(drafts.map(async d => ({
    ...d,
    duplicate: d.parseOk ? await findDuplicateEntry(userId, d) : undefined,
  })));
}

export type QuickEntryCommitInput = Partial<QuickEntryDraft> & { suggestedCategory?: string };

/** Returns the created rows (unformatted); an empty array means nothing valid was committed. */
export async function commitQuickEntries(userId: number, entries: QuickEntryCommitInput[]) {
  // Every entry-creation path must resolve a bookId before insert (see financeLedgerEntriesTable.bookId).
  const resolvedBookId = await resolveBookId(userId);

  const created = [];
  for (const d of entries) {
    if (!d.title?.trim() || !(Number(d.amount) > 0) || !d.kind) continue;
    const [row] = await db.insert(financeLedgerEntriesTable).values({
      userId,
      bookId: resolvedBookId,
      kind: d.kind,
      title: d.title.trim(),
      amount: Number(d.amount),
      currency: d.currency || "BDT",
      category: d.suggestedCategory || "Other",
      occurredDate: d.occurredDate ? new Date(d.occurredDate) : new Date(),
      status: "pending",
    }).returning();
    postEntryJournal(row).catch(() => {});
    notifyEntryCreated(row).catch(() => {});
    created.push(row);
  }
  return created;
}

/** Throws on OCR failure; the route maps that to its 500 response. */
export async function scanReceipt(userId: number, imageBase64: string, currency?: string) {
  const result = await extractReceiptFields(imageBase64, userId, currency || "BDT");
  const duplicate = result.draft ? await findDuplicateEntry(userId, result.draft) : undefined;
  return { ...result, draft: result.draft ? { ...result.draft, duplicate } : null };
}

function smsWebhookUrl(token: string): string {
  const base = process.env.APP_URL ?? "https://ayzen.replit.app";
  return `${base}/api/finance/ai/sms-webhook/${token}`;
}

/** Null when no token could be generated. */
export async function getSmsWebhookInfo(userId: number) {
  const token = await ensureSmsWebhookToken(userId);
  return token ? { token, url: smsWebhookUrl(token) } : null;
}

/** Null when the token could not be rotated. */
export async function rotateSmsWebhookInfo(userId: number) {
  const token = await rotateSmsWebhookToken(userId);
  return token ? { token, url: smsWebhookUrl(token) } : null;
}

export type SmsIngestOutcome =
  | { status: "unknown_token" }
  | { status: "unparsed" }
  | { status: "duplicate"; duplicate: Awaited<ReturnType<typeof findDuplicateEntry>> }
  | { status: "created"; entry: typeof financeLedgerEntriesTable.$inferSelect };

/**
 * Possession of the unguessable token is the only credential (same model as the public receipt link).
 * `onCreated` lets the route supply the in-app notification so this module does not import routes/*.
 */
export async function ingestSmsWebhook(
  token: string,
  text: string,
  onCreated: (userId: number, entry: typeof financeLedgerEntriesTable.$inferSelect, draftKind: string) => void,
): Promise<SmsIngestOutcome> {
  const [user] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.financeSmsWebhookToken, token));
  if (!user) return { status: "unknown_token" };

  const draft = parseBankSms(text);
  if (!draft) return { status: "unparsed" };

  const dup = await findDuplicateEntry(user.id, draft);
  if (dup.isDuplicate) return { status: "duplicate", duplicate: dup };

  // Resolve a bookId, otherwise the entry never appears in GET /finance/entries.
  const resolvedBookId = await resolveBookId(user.id);

  const [row] = await db.insert(financeLedgerEntriesTable).values({
    userId: user.id,
    bookId: resolvedBookId,
    kind: draft.kind,
    title: draft.title,
    amount: draft.amount,
    currency: draft.currency,
    category: draft.suggestedCategory,
    occurredDate: new Date(draft.occurredDate),
    status: "pending",
    notes: `Auto-created from a forwarded SMS — please verify.\n\nOriginal: ${draft.raw}`,
  }).returning();
  postEntryJournal(row).catch(() => {});

  onCreated(user.id, row, draft.kind);
  return { status: "created", entry: row };
}

// Read-only insight helpers the routes call directly (FIN-WP-8: routes import application/* only).
export { detectAnomalies, answerFinanceQuery, detectRecurringCandidates } from "../ai/finance-ai";
