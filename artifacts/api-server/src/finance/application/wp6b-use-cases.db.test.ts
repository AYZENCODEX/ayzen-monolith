import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { PassThrough } from "node:stream";
import { after, test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  financeAccountsTable,
  financeBooksTable,
  financeInvoiceEventsTable,
  financeInvoiceLineItemsTable,
  financeInvoicesTable,
  financeLedgerEntriesTable,
  financePaymentAgreementsTable,
  financeRepaymentsTable,
} from "@workspace/db";
import { cancelInvoice, createInvoice, reopenInvoice, submitInvoicePayment } from "./invoices";
import {
  confirmAgreementWithPasskey,
  createPasskeyOptions,
  disputePaymentAgreement,
  findAgreementByToken,
  findAgreementInvoiceOwner,
  getPublicAgreementView,
  streamAgreementEvidencePdf,
  verifyPaymentAgreement,
} from "./payment-agreements";
import { consumeChallenge } from "../../lib/passkey";

// WP-6b characterization tests for the payment-agreement use cases moved out of routes/finance-invoices.ts, plus the
// new guarantees F19 to F22 (see finance-safety-findings.md). Isolated Finance test schema only (pnpm test:finance-db).
//
// Same method as wp6a-use-cases.db.test.ts: race tests do not rely on timing luck. A second connection takes a row
// lock (and makes its change), the use case is started, the test waits until the use case is really blocked on that
// lock (pg_stat_activity), and only then commits. Failure injection uses throwaway triggers in the isolated schema.
// The WebAuthn check is replaced by a stub (a real assertion needs a hardware key); everything around it is real.

if (process.env.DATABASE_URL_TARGET !== "replit-test") {
  throw new Error('Finance database tests require DATABASE_URL_TARGET="replit-test".');
}

const testUserIds = new Set<number>();
const nextTestUserId = (): number => {
  const userId = -randomInt(1, 2_000_000_000);
  testUserIds.add(userId);
  return userId;
};

after(async () => {
  try {
    await new Promise((r) => setTimeout(r, 300)); // let fire-and-forget event rows settle
    const ids = [...testUserIds];
    if (ids.length) {
      const invoices = await db.select({ id: financeInvoicesTable.id }).from(financeInvoicesTable).where(inArray(financeInvoicesTable.userId, ids));
      const invoiceIds = invoices.map((i) => i.id);
      if (invoiceIds.length) {
        await db.delete(financeInvoiceEventsTable).where(inArray(financeInvoiceEventsTable.invoiceId, invoiceIds));
        await db.delete(financePaymentAgreementsTable).where(inArray(financePaymentAgreementsTable.invoiceId, invoiceIds));
        await db.delete(financeInvoiceLineItemsTable).where(inArray(financeInvoiceLineItemsTable.invoiceId, invoiceIds));
        await db.delete(financeInvoicesTable).where(inArray(financeInvoicesTable.id, invoiceIds));
      }
      await pool.query("DELETE FROM finance_repayments WHERE entry_id IN (SELECT id FROM finance_ledger_entries WHERE user_id = ANY($1::int[]))", [ids]);
      await pool.query("DELETE FROM finance_journal_lines WHERE journal_entry_id IN (SELECT id FROM finance_journal_entries WHERE user_id = ANY($1::int[]))", [ids]);
      await pool.query("DELETE FROM finance_journal_entries WHERE user_id = ANY($1::int[])", [ids]);
      await db.delete(financeLedgerEntriesTable).where(inArray(financeLedgerEntriesTable.userId, ids));
      await db.delete(financeAccountsTable).where(inArray(financeAccountsTable.userId, ids));
      await db.delete(financeBooksTable).where(inArray(financeBooksTable.userId, ids));
      await pool.query("DELETE FROM passkey_credentials WHERE user_id = ANY($1::int[])", [ids]);
      await pool.query("DELETE FROM users WHERE id = ANY($1::int[])", [ids]);
    }
  } finally {
    await pool.end();
  }
});

// drizzle wraps driver errors as 'Failed query: ...'; the trigger's own message is on `cause`.
const INJECTED = (err: any) => /injected failure/.test(`${err?.message} ${err?.cause?.message}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const req = { ip: "::ffff:203.0.113.9", socket: {}, headers: { "user-agent": "wp6b-test" } } as any;

async function newUser(): Promise<number> {
  const id = nextTestUserId();
  await pool.query(
    "INSERT INTO users (id, username, email, finance_invoice_number_prefix) VALUES ($1, $2, $3, 'INV')",
    [id, `user${-id}`, `user${-id}@test.local`],
  );
  return id;
}

const LINES = [{ description: "Design", quantity: 2, unitPrice: 50 }]; // total 100
async function newInvoice(userId: number, over: Record<string, any> = {}) {
  const result = await createInvoice(userId, { debtorName: "Dee", debtorEmail: null, ...over }, LINES);
  assert.equal(result.status, "ok");
  return (result as Extract<typeof result, { status: "ok" }>).invoice;
}
const invoiceRow = async (id: number) => (await db.select().from(financeInvoicesTable).where(eq(financeInvoicesTable.id, id)))[0];
const agreementRow = async (id: number) => (await db.select().from(financePaymentAgreementsTable).where(eq(financePaymentAgreementsTable.id, id)))[0];
const setAgreement = (id: number, patch: Record<string, any>) => db.update(financePaymentAgreementsTable).set(patch).where(eq(financePaymentAgreementsTable.id, id));
const setInvoice = (id: number, patch: Record<string, any>) => db.update(financeInvoicesTable).set(patch).where(eq(financeInvoicesTable.id, id));
const entryRow = async (id: number) => (await db.select().from(financeLedgerEntriesTable).where(eq(financeLedgerEntriesTable.id, id)))[0];
const repaymentsOf = (entryId: number) => db.select().from(financeRepaymentsTable).where(eq(financeRepaymentsTable.entryId, entryId));
const eventTypes = async (invoiceId: number) =>
  (await db.select().from(financeInvoiceEventsTable).where(eq(financeInvoiceEventsTable.invoiceId, invoiceId))).map((e) => e.eventType).sort();

/** A submitted claim by `payer` against the invoice, optionally moved straight to a later status. */
async function newClaim(inv: { invoiceToken: string; id: number }, payer: number, amount?: number, status = "passkey_confirmed") {
  const res = await submitInvoicePayment(payer, inv.invoiceToken, { methodType: "bkash", referenceId: `TX${randomInt(1, 1_000_000)}`, amount }, req);
  assert.equal(res.status, "ok");
  const agreement = await findAgreementByToken((res as Extract<typeof res, { status: "ok" }>).agreementToken);
  assert.ok(agreement);
  if (status !== "submitted") await setAgreement(agreement.id, { status, confirmedAt: new Date() });
  return agreement;
}

/**
 * A claim that is already queued on the invoice without going through submit. Submit now refuses claims that would
 * exceed the balance together with the pending ones, so tests of verify's own F21 guard (stacked claims that exist
 * anyway: queued before that rule, or written by something other than submit) insert them directly.
 */
async function stackedClaim(inv: { id: number }, payer: number, amount: number, status = "passkey_confirmed") {
  const [agreement] = await db.insert(financePaymentAgreementsTable).values({
    invoiceId: inv.id, payerUserId: payer, methodType: "bkash", referenceId: `STK${randomInt(1, 1_000_000)}`, amount,
    submittedAt: new Date(), agreementToken: `stk-${randomInt(1, 2_000_000_000)}-${randomInt(1, 2_000_000_000)}`, status,
    confirmedAt: status === "submitted" ? null : new Date(),
  }).returning();
  return agreement;
}

/** Holds a row lock on a second connection and applies `statements` inside that transaction. */
async function holdLock(lockSql: string, lockParams: any[], statements: Array<[string, any[]]>) {
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query(lockSql, lockParams);
  for (const [text, params] of statements) await client.query(text, params);
  return {
    async commit() { await client.query("COMMIT"); client.release(); },
  };
}
const holdInvoice = (invoiceId: number, statements: Array<[string, any[]]>) =>
  holdLock("SELECT id FROM finance_invoices WHERE id = $1 FOR UPDATE", [invoiceId], statements);
const holdAgreement = (agreementId: number, statements: Array<[string, any[]]>) =>
  holdLock("SELECT id FROM finance_payment_agreements WHERE id = $1 FOR UPDATE", [agreementId], statements);

async function waitUntilBlocked(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()");
    if (rows[0].n > 0) return;
    await sleep(30);
  }
  throw new Error("the use case never blocked on the row lock; the interleaving was not exercised");
}
async function raceWithCommit<T>(held: { commit(): Promise<void> }, run: () => Promise<T>): Promise<T> {
  const pending = run();
  pending.catch(() => {});
  await waitUntilBlocked();
  await held.commit();
  return pending;
}

async function withFailingTrigger<T>(table: string, when: string, fn: () => Promise<T>): Promise<T> {
  const name = `wp6b_boom_${randomInt(1, 1_000_000)}`;
  await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`);
  await pool.query(`CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION ${name}()`);
  try {
    return await fn();
  } finally {
    await pool.query(`DROP TRIGGER ${name} ON ${table}`);
    await pool.query(`DROP FUNCTION ${name}()`);
  }
}

function pdfSink() {
  const out = new PassThrough() as PassThrough & { setHeader(name: string, value: string): void; headers: Record<string, string> };
  out.headers = {};
  out.setHeader = (name, value) => { out.headers[name.toLowerCase()] = value; };
  const chunks: Buffer[] = [];
  out.on("data", (c) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => out.on("end", () => resolve(Buffer.concat(chunks))));
  return { out, done };
}

// Passkey stand-ins: a registered credential row and a WebAuthn verifier that records what it was given.
let credCounter = 0;
async function addPasskey(userId: number, counter = 1) {
  const credentialId = `cred-${Date.now()}-${++credCounter}`;
  const { rows } = await pool.query(
    "INSERT INTO passkey_credentials (user_id, credential_id, public_key, counter, transports) VALUES ($1, $2, $3, $4, 'internal') RETURNING id",
    [userId, credentialId, Buffer.from("public-key-bytes").toString("base64url"), counter],
  );
  return { id: rows[0].id as number, credentialId };
}
const credRow = async (id: number) => (await pool.query("SELECT counter, last_used_at FROM passkey_credentials WHERE id = $1", [id])).rows[0];
function stubVerifier(result: { verified: boolean; newCounter?: number } | Error) {
  const calls: any[] = [];
  const verifyAuthentication = async (args: any) => {
    calls.push(args);
    if (result instanceof Error) throw result;
    return { verified: result.verified, authenticationInfo: { newCounter: result.newCounter ?? 0 } };
  };
  return { calls, deps: { verifyAuthentication } };
}
const confirmInput = (credentialId: string) => ({ challenge: "chal-123", response: { id: credentialId, type: "public-key" }, rpID: "localhost", origin: "http://localhost:5173" });

// ─── Lookups and public view ─────────────────────────────────────────────────

test("findAgreementByToken and findAgreementInvoiceOwner return the agreement and the creditor, and null for unknowns", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const inv = await newInvoice(userId);
  const agreement = await newClaim(inv, payer, undefined, "submitted");
  assert.equal((await findAgreementByToken(agreement.agreementToken))?.id, agreement.id);
  assert.equal(await findAgreementByToken("nope"), undefined);
  const owner = await findAgreementInvoiceOwner(agreement.id);
  assert.equal(owner?.ownerId, userId, "the owner is the invoice's creditor, not the payer");
  assert.equal(owner?.invoiceId, inv.id);
  assert.equal(await findAgreementInvoiceOwner(987654321), null);
});

test("getPublicAgreementView returns the payer-facing payload and flags when evidence is available", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const inv = await newInvoice(userId, { currency: "USD" });
  const agreement = await newClaim(inv, payer, 40, "submitted");
  const view = await getPublicAgreementView(agreement.agreementToken);
  assert.ok(view);
  assert.equal(view.id, agreement.id);
  assert.equal(view.status, "submitted");
  assert.equal(view.methodType, "bkash");
  assert.equal(view.amount, 40);
  assert.equal(view.currency, "USD");
  assert.equal(view.invoiceTitle, `Invoice #${inv.id}`);
  assert.equal(view.creditorName, `user${-userId}`);
  assert.equal(view.debtorName, "Dee");
  assert.equal(typeof view.submittedAt, "string");
  assert.equal(view.confirmedAt, null);
  assert.equal(view.evidenceAvailable, false);
  for (const [status, available] of [["passkey_confirmed", true], ["creditor_verified", true], ["disputed", false]] as const) {
    await setAgreement(agreement.id, { status });
    assert.equal((await getPublicAgreementView(agreement.agreementToken))?.evidenceAvailable, available, status);
  }
  assert.equal(await getPublicAgreementView("nope"), null);
});

// ─── Passkey options ─────────────────────────────────────────────────────────

test("createPasskeyOptions refuses a payer with no passkey and otherwise stores a challenge only that payer can use", async () => {
  const payer = await newUser();
  assert.deepEqual(await createPasskeyOptions(payer, "localhost"), { status: "no_passkey" });
  const cred = await addPasskey(payer);
  const res = await createPasskeyOptions(payer, "localhost");
  assert.equal(res.status, "ok");
  if (res.status !== "ok") return;
  assert.equal(res.options.rpId, "localhost");
  assert.deepEqual(res.options.allowCredentials?.map((c) => c.id), [cred.credentialId]);
  const stored = consumeChallenge(res.challengeKey);
  assert.equal(stored?.challenge, res.options.challenge);
  assert.equal(stored?.userId, payer);
  assert.equal(consumeChallenge(res.challengeKey), null, "a challenge is single-use");
  // only the caller's own credentials are offered
  const other = await newUser();
  await addPasskey(other);
  const mine = await createPasskeyOptions(payer, "localhost");
  assert.equal(mine.status === "ok" && mine.options.allowCredentials?.length, 1);
});

// ─── Passkey confirmation ────────────────────────────────────────────────────

test("confirmAgreementWithPasskey marks the agreement confirmed, records the evidence and advances the passkey counter", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const inv = await newInvoice(userId);
  const agreement = await newClaim(inv, payer, undefined, "submitted");
  const cred = await addPasskey(payer, 3);
  const verifier = stubVerifier({ verified: true, newCounter: 9 });
  const res = await confirmAgreementWithPasskey(payer, agreement, confirmInput(cred.credentialId), req, verifier.deps);
  assert.equal(res.status, "ok");
  if (res.status !== "ok") return;
  assert.equal(res.agreement.status, "passkey_confirmed");
  const row = await agreementRow(agreement.id);
  assert.equal(row.status, "passkey_confirmed");
  assert.ok(row.confirmedAt);
  assert.equal(row.passkeyCredentialId, cred.id);
  assert.equal(row.ipAddress, "203.0.113.9");
  assert.equal(row.userAgent, "wp6b-test");
  const c = await credRow(cred.id);
  assert.equal(c.counter, 9);
  assert.ok(c.last_used_at);
  // the verifier saw the stored credential and the expected challenge, origin and RP id
  assert.equal(verifier.calls.length, 1);
  assert.equal(verifier.calls[0].expectedChallenge, "chal-123");
  assert.equal(verifier.calls[0].expectedRPID, "localhost");
  assert.equal(verifier.calls[0].expectedOrigin, "http://localhost:5173");
  assert.equal(verifier.calls[0].credential.id, cred.credentialId);
  assert.equal(verifier.calls[0].credential.counter, 3);
  assert.deepEqual(verifier.calls[0].credential.transports, ["internal"]);
  await sleep(250);
  assert.deepEqual(await eventTypes(inv.id), ["agreement_confirmed", "payment_submitted"]);
});

test("confirmAgreementWithPasskey refuses a passkey that is not the payer's and a failed WebAuthn check, and changes nothing", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const stranger = await newUser();
  const inv = await newInvoice(userId);
  const agreement = await newClaim(inv, payer, undefined, "submitted");
  const strangerCred = await addPasskey(stranger);
  const cred = await addPasskey(payer, 5);

  const never = stubVerifier({ verified: true, newCounter: 99 });
  assert.deepEqual(await confirmAgreementWithPasskey(payer, agreement, confirmInput("unknown-credential"), req, never.deps), { status: "not_registered" });
  assert.deepEqual(await confirmAgreementWithPasskey(payer, agreement, confirmInput(strangerCred.credentialId), req, never.deps), { status: "not_registered" }, "another user's credential id");
  assert.equal(never.calls.length, 0, "WebAuthn is never reached for a credential that is not the caller's");

  assert.deepEqual(await confirmAgreementWithPasskey(payer, agreement, confirmInput(cred.credentialId), req, stubVerifier({ verified: false }).deps), { status: "failed", message: "Passkey verification failed" });
  assert.deepEqual(await confirmAgreementWithPasskey(payer, agreement, confirmInput(cred.credentialId), req, stubVerifier(new Error("bad signature")).deps), { status: "failed", message: "bad signature" });
  assert.deepEqual(await confirmAgreementWithPasskey(payer, agreement, confirmInput(cred.credentialId), req, stubVerifier(new Error("")).deps), { status: "failed", message: "Passkey verification failed" });

  assert.equal((await agreementRow(agreement.id)).status, "submitted");
  assert.equal((await credRow(cred.id)).counter, 5, "the counter only moves after a verified assertion");
});

test("F19: a dispute that lands while the confirmation waits is not undone (the old code wrote 'passkey_confirmed' over it)", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const inv = await newInvoice(userId);
  const agreement = await newClaim(inv, payer, undefined, "submitted");
  const cred = await addPasskey(payer, 1);
  const held = await holdAgreement(agreement.id, [
    ["UPDATE finance_payment_agreements SET status = 'disputed', dispute_reason = 'no money arrived' WHERE id = $1", [agreement.id]],
  ]);
  const res = await raceWithCommit(held, () => confirmAgreementWithPasskey(payer, agreement, confirmInput(cred.credentialId), req, stubVerifier({ verified: true, newCounter: 4 }).deps));
  assert.deepEqual(res, { status: "not_submitted", current: "disputed" });
  const row = await agreementRow(agreement.id);
  assert.equal(row.status, "disputed");
  assert.equal(row.confirmedAt, null);
  assert.equal(row.ipAddress, null);
  assert.equal((await credRow(cred.id)).counter, 4, "the assertion was valid and used, so the counter still advances");
  await sleep(250);
  assert.ok(!(await eventTypes(inv.id)).includes("agreement_confirmed"), "no confirmation event for a refused confirmation");
});

test("F19: confirming twice at once confirms once", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const inv = await newInvoice(userId);
  const agreement = await newClaim(inv, payer, undefined, "submitted");
  const cred = await addPasskey(payer);
  const results = await Promise.all([1, 2].map(() => confirmAgreementWithPasskey(payer, agreement, confirmInput(cred.credentialId), req, stubVerifier({ verified: true, newCounter: 2 }).deps)));
  assert.deepEqual(results.map((r) => r.status).sort(), ["not_submitted", "ok"]);
  await sleep(250);
  assert.equal((await eventTypes(inv.id)).filter((t) => t === "agreement_confirmed").length, 1);
});

test("a database failure while confirming is a real error, not a 'passkey failed', and rolls the counter back too", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const inv = await newInvoice(userId);
  const agreement = await newClaim(inv, payer, undefined, "submitted");
  const cred = await addPasskey(payer, 6);
  await withFailingTrigger("finance_payment_agreements", `NEW.status = 'passkey_confirmed' AND NEW.id = ${agreement.id}`, async () => {
    await assert.rejects(confirmAgreementWithPasskey(payer, agreement, confirmInput(cred.credentialId), req, stubVerifier({ verified: true, newCounter: 8 }).deps), INJECTED);
  });
  assert.equal((await agreementRow(agreement.id)).status, "submitted");
  assert.equal((await credRow(cred.id)).counter, 6, "counter and confirmation commit together");
});

// ─── Evidence PDF ────────────────────────────────────────────────────────────

test("streamAgreementEvidencePdf streams a real PDF for a confirmed or verified agreement and nothing otherwise", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const inv = await newInvoice(userId);
  const agreement = await newClaim(inv, payer, undefined, "submitted");

  assert.equal(await streamAgreementEvidencePdf(pdfSink().out as any, "nope"), false);
  for (const status of ["submitted", "disputed"]) {
    await setAgreement(agreement.id, { status });
    const sink = pdfSink();
    assert.equal(await streamAgreementEvidencePdf(sink.out as any, agreement.agreementToken), false, status);
    assert.equal(sink.out.headers["content-type"], undefined, "nothing is written for a refused request");
  }
  for (const status of ["passkey_confirmed", "creditor_verified"]) {
    await setAgreement(agreement.id, { status, confirmedAt: new Date() });
    const sink = pdfSink();
    assert.equal(await streamAgreementEvidencePdf(sink.out as any, agreement.agreementToken), true, status);
    assert.equal((await sink.done).subarray(0, 5).toString(), "%PDF-");
    assert.equal(sink.out.headers["content-type"], "application/pdf");
    assert.match(sink.out.headers["content-disposition"], new RegExp(`ayzen-payment-agreement-${agreement.id}\\.pdf`));
  }
});

// ─── Verify ──────────────────────────────────────────────────────────────────

test("verifyPaymentAgreement settles a fully paid invoice with no linked entry and logs creditor_verified", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const inv = await newInvoice(userId);
  const agreement = await newClaim(inv, payer);
  const res = await verifyPaymentAgreement(userId, agreement.id, "matches my statement", req);
  assert.equal(res.status, "ok");
  if (res.status !== "ok") return;
  assert.equal(res.agreement.status, "creditor_verified");
  const row = await agreementRow(agreement.id);
  assert.equal(row.status, "creditor_verified");
  assert.ok(row.creditorVerifiedAt);
  assert.equal(row.creditorVerifiedBy, userId);
  assert.equal(row.creditorNotes, "matches my statement");
  const after = await invoiceRow(inv.id);
  assert.equal(after.paidAmount, 100);
  assert.equal(after.status, "paid");
  await sleep(250);
  assert.ok((await eventTypes(inv.id)).includes("creditor_verified"));
});

test("verifyPaymentAgreement posts a real repayment against the linked entry and settles invoices in parts", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const entry = (await db.insert(financeLedgerEntriesTable).values({ userId, kind: "receivable", title: "Retainer", amount: 100 }).returning())[0];
  const inv = await newInvoice(userId, { entryId: entry.id });
  const first = await newClaim(inv, payer, 40);
  assert.equal((await verifyPaymentAgreement(userId, first.id, undefined, req)).status, "ok");
  let invoice = await invoiceRow(inv.id);
  assert.equal(invoice.paidAmount, 40);
  assert.equal(invoice.status, "partially_paid");
  let e = await entryRow(entry.id);
  assert.equal(e.amount, 60, "what is still outstanding goes down");
  assert.equal(e.status, "partial");
  const repayments = await repaymentsOf(entry.id);
  assert.equal(repayments.length, 1);
  assert.equal(repayments[0].amount, 40);
  assert.equal(repayments[0].isInterest, 0);
  assert.match(repayments[0].notes ?? "", new RegExp(`Verified from Payment Agreement #${first.id} \\(.*, ref TX\\d+\\)`));

  const second = await newClaim(inv, payer, 60);
  assert.equal((await verifyPaymentAgreement(userId, second.id, undefined, req)).status, "ok");
  invoice = await invoiceRow(inv.id);
  assert.equal(invoice.paidAmount, 100);
  assert.equal(invoice.status, "paid");
  e = await entryRow(entry.id);
  assert.equal(e.amount, 0);
  assert.equal(e.status, "paid");
  assert.equal((await repaymentsOf(entry.id)).length, 2);
  await sleep(250);
  assert.deepEqual((await eventTypes(inv.id)).filter((t) => t.endsWith("verified")), ["creditor_verified", "partially_verified"]);
});

test("verifyPaymentAgreement skips the repayment when the linked entry is not repayable but still counts the invoice payment", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const entry = (await db.insert(financeLedgerEntriesTable).values({ userId, kind: "expense", title: "old link", amount: 100 }).returning())[0];
  const inv = await newInvoice(userId);
  await setInvoice(inv.id, { entryId: entry.id }); // creation blocks this link; older invoices could still have it
  const agreement = await newClaim(inv, payer);
  assert.equal((await verifyPaymentAgreement(userId, agreement.id, undefined, req)).status, "ok");
  assert.deepEqual(await repaymentsOf(entry.id), []);
  assert.equal((await entryRow(entry.id)).amount, 100);
  assert.equal((await invoiceRow(inv.id)).paidAmount, 100);
});

test("verifyPaymentAgreement answers like the route did for unknown, foreign and not-yet-confirmed agreements", async () => {
  const userId = await newUser();
  const other = await newUser();
  const payer = await newUser();
  const inv = await newInvoice(userId);
  const agreement = await newClaim(inv, payer, undefined, "submitted");
  assert.deepEqual(await verifyPaymentAgreement(userId, 987654321, undefined, req), { status: "not_found" });
  assert.deepEqual(await verifyPaymentAgreement(other, agreement.id, undefined, req), { status: "not_found" }, "the payer's creditor only");
  assert.deepEqual(await verifyPaymentAgreement(payer, agreement.id, undefined, req), { status: "not_found" }, "the payer cannot verify their own claim");
  assert.deepEqual(await verifyPaymentAgreement(userId, agreement.id, undefined, req), { status: "not_confirmed" });
  await setAgreement(agreement.id, { status: "disputed" });
  assert.deepEqual(await verifyPaymentAgreement(userId, agreement.id, undefined, req), { status: "not_confirmed" });
  await setAgreement(agreement.id, { status: "creditor_verified" });
  assert.deepEqual(await verifyPaymentAgreement(userId, agreement.id, undefined, req), { status: "not_confirmed" }, "a repeat after the fact is a 400, as before");
  const inv2 = await invoiceRow(inv.id);
  assert.equal(inv2.paidAmount, 0);
});

test("verifying the same agreement twice at once posts one repayment and counts it once", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const entry = (await db.insert(financeLedgerEntriesTable).values({ userId, kind: "receivable", title: "r", amount: 100 }).returning())[0];
  const inv = await newInvoice(userId, { entryId: entry.id });
  const agreement = await newClaim(inv, payer, 60);
  const results = await Promise.all([1, 2, 3].map(() => verifyPaymentAgreement(userId, agreement.id, undefined, req)));
  // Exactly one winner. A loser that pre-checked before the winner committed gets "already_verified" (it re-read the row
  // under the lock); one that pre-checked after gets "not_confirmed" (the 400 a repeat always got). Which one depends on
  // timing, so both are accepted; what must hold is one "ok", no other outcome, and the books below.
  const statuses = results.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === "ok").length, 1, `exactly one verify wins, got ${statuses.join(",")}`);
  assert.ok(statuses.filter((s) => s !== "ok").every((s) => s === "already_verified" || s === "not_confirmed"), `losers are refused, got ${statuses.join(",")}`);
  assert.equal((await repaymentsOf(entry.id)).length, 1);
  assert.equal((await entryRow(entry.id)).amount, 40);
  assert.equal((await invoiceRow(inv.id)).paidAmount, 60);
});

test("F21: a second claim for the full amount cannot be verified once the first one has been (paidAmount never exceeds the invoice)", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const entry = (await db.insert(financeLedgerEntriesTable).values({ userId, kind: "receivable", title: "r", amount: 100 }).returning())[0];
  const inv = await newInvoice(userId, { entryId: entry.id });
  const a = await newClaim(inv, payer, 100);
  const b = await stackedClaim(inv, payer, 100); // submit refuses this now; verify must still hold if it exists
  assert.equal((await verifyPaymentAgreement(userId, a.id, undefined, req)).status, "ok");
  assert.deepEqual(await verifyPaymentAgreement(userId, b.id, undefined, req), { status: "exceeds_remaining", currency: "BDT", remaining: 0 });
  assert.equal((await agreementRow(b.id)).status, "passkey_confirmed", "the refused claim stays reviewable (the creditor can dispute it)");
  assert.equal((await invoiceRow(inv.id)).paidAmount, 100);
  assert.equal((await entryRow(entry.id)).amount, 0, "the entry is repaid once, not pushed below zero by a second repayment");
  assert.equal((await repaymentsOf(entry.id)).length, 1);
});

test("F21: two full-amount claims verified at the same time settle exactly one of them", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const inv = await newInvoice(userId);
  const a = await newClaim(inv, payer, 100);
  const b = await stackedClaim(inv, payer, 100);
  const results = await Promise.all([verifyPaymentAgreement(userId, a.id, undefined, req), verifyPaymentAgreement(userId, b.id, undefined, req)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["exceeds_remaining", "ok"]);
  assert.equal((await invoiceRow(inv.id)).paidAmount, 100);
});

test("F21: the remaining balance is measured against what is really paid, with the 0.01 tolerance kept", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const inv = await newInvoice(userId);
  const a = await newClaim(inv, payer, 40);
  const b = await stackedClaim(inv, payer, 70);
  assert.equal((await verifyPaymentAgreement(userId, a.id, undefined, req)).status, "ok");
  assert.deepEqual(await verifyPaymentAgreement(userId, b.id, undefined, req), { status: "exceeds_remaining", currency: "BDT", remaining: 60 });
  // a claim that fits within the tolerance is still accepted
  const c = await stackedClaim(inv, payer, 60.005);
  assert.equal((await verifyPaymentAgreement(userId, c.id, undefined, req)).status, "ok");
  assert.equal((await invoiceRow(inv.id)).status, "paid");
});

test("verify rolls back as one unit: a failed repayment insert leaves the claim, the entry and the invoice untouched", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const entry = (await db.insert(financeLedgerEntriesTable).values({ userId, kind: "receivable", title: "r", amount: 100 }).returning())[0];
  const inv = await newInvoice(userId, { entryId: entry.id });
  const agreement = await newClaim(inv, payer, 50);
  await withFailingTrigger("finance_repayments", `NEW.entry_id = ${entry.id}`, async () => {
    await assert.rejects(verifyPaymentAgreement(userId, agreement.id, undefined, req), INJECTED);
  });
  assert.equal((await agreementRow(agreement.id)).status, "passkey_confirmed", "the claim is released so a retry works");
  assert.equal((await entryRow(entry.id)).amount, 100);
  assert.equal((await invoiceRow(inv.id)).paidAmount, 0);
  assert.deepEqual(await repaymentsOf(entry.id), []);
  // and the retry after the failure goes through exactly once
  assert.equal((await verifyPaymentAgreement(userId, agreement.id, undefined, req)).status, "ok");
  assert.equal((await repaymentsOf(entry.id)).length, 1);
});

test("a dispute that commits while verify waits for the invoice lock wins: nothing is posted", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const entry = (await db.insert(financeLedgerEntriesTable).values({ userId, kind: "receivable", title: "r", amount: 100 }).returning())[0];
  const inv = await newInvoice(userId, { entryId: entry.id });
  const agreement = await newClaim(inv, payer, 100);
  const held = await holdInvoice(inv.id, [
    ["UPDATE finance_payment_agreements SET status = 'disputed' WHERE id = $1", [agreement.id]],
    ["UPDATE finance_invoices SET status = 'disputed' WHERE id = $1", [inv.id]],
  ]);
  const res = await raceWithCommit(held, () => verifyPaymentAgreement(userId, agreement.id, undefined, req));
  assert.deepEqual(res, { status: "changed" });
  assert.equal((await agreementRow(agreement.id)).status, "disputed");
  assert.equal((await invoiceRow(inv.id)).paidAmount, 0);
  assert.equal((await invoiceRow(inv.id)).status, "disputed");
  assert.deepEqual(await repaymentsOf(entry.id), []);
});

// ─── Dispute ─────────────────────────────────────────────────────────────────

test("disputePaymentAgreement disputes the claim, parks the invoice in 'disputed', logs the event and trims the reason", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const inv = await newInvoice(userId);
  const agreement = await newClaim(inv, payer);
  const res = await disputePaymentAgreement(userId, agreement.id, "  reference does not match  ", req);
  assert.equal(res.status, "ok");
  if (res.status !== "ok") return;
  assert.equal(res.agreement.status, "disputed");
  const row = await agreementRow(agreement.id);
  assert.equal(row.status, "disputed");
  assert.equal(row.disputeReason, "reference does not match");
  assert.equal(row.disputedBy, userId);
  assert.ok(row.disputedAt);
  const after = await invoiceRow(inv.id);
  assert.equal(after.status, "disputed");
  assert.equal(after.paidAmount, 0, "a dispute never touches the paid amount");
  await sleep(250);
  assert.ok((await eventTypes(inv.id)).includes("agreement_disputed"));
  // a disputed claim blocks new claims until the creditor reopens (the 6a flow still works on top of this)
  assert.equal((await submitInvoicePayment(payer, inv.invoiceToken, { methodType: "bkash" }, req)).status, "disputed");
  assert.equal((await reopenInvoice(userId, inv.id, req)).status, "ok");
  assert.equal((await invoiceRow(inv.id)).status, "viewed");
});

test("disputePaymentAgreement answers like the route did for unknown, foreign, verified and already disputed agreements", async () => {
  const userId = await newUser();
  const other = await newUser();
  const payer = await newUser();
  const inv = await newInvoice(userId);
  const agreement = await newClaim(inv, payer);
  const verified = await stackedClaim(inv, payer, 10, "creditor_verified"); // made before the invoice is parked in "disputed"
  assert.deepEqual(await disputePaymentAgreement(userId, 987654321, "x", req), { status: "not_found" });
  assert.deepEqual(await disputePaymentAgreement(other, agreement.id, "x", req), { status: "not_found" });
  assert.equal((await agreementRow(agreement.id)).status, "passkey_confirmed");
  assert.equal((await invoiceRow(inv.id)).status, "payment_submitted");

  assert.equal((await disputePaymentAgreement(userId, agreement.id, "first", req)).status, "ok");
  assert.deepEqual(await disputePaymentAgreement(userId, agreement.id, "second", req), { status: "already_disputed" });
  assert.equal((await agreementRow(agreement.id)).disputeReason, "first");

  assert.deepEqual(await disputePaymentAgreement(userId, verified.id, "late", req), { status: "already_verified" });
  assert.equal((await agreementRow(verified.id)).status, "creditor_verified");
});

test("a submitted (not yet confirmed) claim can be disputed too, as before", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const inv = await newInvoice(userId);
  const agreement = await newClaim(inv, payer, undefined, "submitted");
  assert.equal((await disputePaymentAgreement(userId, agreement.id, "never received", req)).status, "ok");
  assert.equal((await agreementRow(agreement.id)).status, "disputed");
});

test("F20: disputing a stale claim never un-settles a paid or cancelled invoice, and a partly paid one is parked", async () => {
  const userId = await newUser();
  const payer = await newUser();
  for (const [status, paidAmount, expected] of [["paid", 100, "paid"], ["creditor_verified", 100, "creditor_verified"], ["cancelled", 0, "cancelled"], ["partially_paid", 40, "disputed"]] as const) {
    const inv = await newInvoice(userId);
    const agreement = await newClaim(inv, payer, 10);
    await setInvoice(inv.id, { status, paidAmount });
    assert.equal((await disputePaymentAgreement(userId, agreement.id, "stale", req)).status, "ok", status);
    assert.equal((await agreementRow(agreement.id)).status, "disputed", `${status}: the claim itself is still rejected`);
    assert.equal((await invoiceRow(inv.id)).status, expected, status);
    assert.equal((await invoiceRow(inv.id)).paidAmount, paidAmount);
  }
});

test("F20: a verify that commits while the dispute waits wins: the dispute is refused and the paid invoice stays paid", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const inv = await newInvoice(userId);
  const agreement = await newClaim(inv, payer, 100);
  const held = await holdInvoice(inv.id, [
    ["UPDATE finance_payment_agreements SET status = 'creditor_verified' WHERE id = $1", [agreement.id]],
    ["UPDATE finance_invoices SET status = 'paid', paid_amount = 100 WHERE id = $1", [inv.id]],
  ]);
  const res = await raceWithCommit(held, () => disputePaymentAgreement(userId, agreement.id, "too late", req));
  assert.deepEqual(res, { status: "already_verified" });
  assert.equal((await agreementRow(agreement.id)).status, "creditor_verified", "the old code wrote 'disputed' over a verified claim");
  assert.equal((await agreementRow(agreement.id)).disputeReason, null);
  const after = await invoiceRow(inv.id);
  assert.equal(after.status, "paid");
  assert.equal(after.paidAmount, 100);
});

test("F20: disputing twice at once disputes once", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const inv = await newInvoice(userId);
  const agreement = await newClaim(inv, payer);
  const results = await Promise.all(["a", "b"].map((r) => disputePaymentAgreement(userId, agreement.id, r, req)));
  assert.deepEqual(results.map((r) => r.status).sort(), ["already_disputed", "ok"]);
  await sleep(250);
  assert.equal((await eventTypes(inv.id)).filter((t) => t === "agreement_disputed").length, 1);
});

test("F20: dispute is one unit: a failed invoice update leaves the agreement undisputed", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const inv = await newInvoice(userId, { debtorName: "FAIL-ME" });
  const agreement = await newClaim(inv, payer);
  await withFailingTrigger("finance_invoices", "NEW.status = 'disputed' AND NEW.debtor_name = 'FAIL-ME'", async () => {
    await assert.rejects(disputePaymentAgreement(userId, agreement.id, "x", req), INJECTED);
  });
  const row = await agreementRow(agreement.id);
  assert.equal(row.status, "passkey_confirmed", "the old code had already written 'disputed' when the invoice update failed");
  assert.equal(row.disputeReason, null);
  assert.equal((await invoiceRow(inv.id)).status, "payment_submitted");
});

// ─── Cancel (F22, exercised against the agreement flow) ──────────────────────

test("F22: an invoice that a verify just settled cannot be cancelled, and cancelling waits for an in-flight verify", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const inv = await newInvoice(userId);
  const agreement = await newClaim(inv, payer, 100);
  assert.equal((await verifyPaymentAgreement(userId, agreement.id, undefined, req)).status, "ok");
  assert.deepEqual(await cancelInvoice(userId, inv.id), { status: "already_paid" });
  assert.equal((await invoiceRow(inv.id)).status, "paid");

  const inv2 = await newInvoice(userId);
  const held = await holdInvoice(inv2.id, [["UPDATE finance_invoices SET status = 'paid', paid_amount = 100 WHERE id = $1", [inv2.id]]]);
  const res = await raceWithCommit(held, () => cancelInvoice(userId, inv2.id));
  assert.deepEqual(res, { status: "already_paid" }, "the old code cancelled over the payment that had just been verified");
  assert.equal((await invoiceRow(inv2.id)).status, "paid");
});

// ─── Submit counts pending claims (F21 follow-up, product decision) ──────────

const submit = (payer: number, inv: { invoiceToken: string }, amount?: number) =>
  submitInvoicePayment(payer, inv.invoiceToken, { methodType: "bkash", referenceId: `TX${randomInt(1, 1_000_000)}`, amount }, req);

test("submit refuses a claim that, with the claims already waiting, would exceed the balance; an omitted amount claims only what is left", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const inv = await newInvoice(userId); // 100
  assert.equal((await submit(payer, inv, 60)).status, "ok");
  assert.deepEqual(await submit(payer, inv, 50), { status: "pending_claims", currency: inv.currency, pending: 60, available: 40 });
  const rest = await submit(payer, inv); // no amount: claims the unclaimed 40, not the full remaining 100
  assert.equal(rest.status, "ok");
  const claims = (await db.select().from(financePaymentAgreementsTable).where(eq(financePaymentAgreementsTable.invoiceId, inv.id))).map((a) => a.amount).sort((a, b) => a - b);
  assert.deepEqual(claims, [40, 60]);
  // everything is now claimed
  assert.deepEqual(await submit(payer, inv, 1), { status: "pending_claims", currency: inv.currency, pending: 100, available: 0 });
  assert.deepEqual(await submit(payer, inv), { status: "pending_claims", currency: inv.currency, pending: 100, available: 0 });
  assert.equal((await invoiceRow(inv.id)).paidAmount, 0);
});

test("a disputed claim stops counting, a verified one counts through paidAmount (never twice), a claim above the invoice keeps its old message", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const inv = await newInvoice(userId);
  const first = await submit(payer, inv, 60);
  assert.equal(first.status, "ok");
  assert.equal((await submit(payer, inv, 60)).status, "pending_claims");
  const a1 = await findAgreementByToken((first as Extract<typeof first, { status: "ok" }>).agreementToken);
  await setAgreement(a1!.id, { status: "passkey_confirmed", confirmedAt: new Date() });
  assert.equal((await disputePaymentAgreement(userId, a1!.id, "reference does not match", req)).status, "ok");
  await setInvoice(inv.id, { status: "viewed" }); // creditor reopened
  const second = await submit(payer, inv, 60);
  assert.equal(second.status, "ok", "the disputed 60 no longer blocks a new 60");
  const a2 = await findAgreementByToken((second as Extract<typeof second, { status: "ok" }>).agreementToken);
  await setAgreement(a2!.id, { status: "passkey_confirmed", confirmedAt: new Date() });
  assert.equal((await verifyPaymentAgreement(userId, a2!.id, undefined, req)).status, "ok");
  assert.equal((await submit(payer, inv, 41)).status, "exceeds_remaining", "above what is left on the invoice");
  assert.equal((await submit(payer, inv, 40)).status, "ok", "verified 60 counted once; 40 is still claimable");
  assert.equal((await submit(payer, inv, 1)).status, "pending_claims");
});

test("two claims submitted at the same moment for more than the balance: exactly one is accepted", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const inv = await newInvoice(userId);
  const results = await Promise.all([submit(payer, inv, 60), submit(payer, inv, 60), submit(payer, inv, 60)]);
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, ["ok", "pending_claims", "pending_claims"]);
  assert.equal((await db.select().from(financePaymentAgreementsTable).where(eq(financePaymentAgreementsTable.invoiceId, inv.id))).length, 1);
});

// ─── Cancel a paid invoice as an appeal: the payment was not received ────────

const REASON = { reversePayments: { reason: "payment never arrived (fake receipt)" } };
const journalMemos = async (entryId: number) =>
  (await pool.query("SELECT memo, (SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(credit),0) FROM finance_journal_lines l WHERE l.journal_entry_id = j.id)::float8 AS imbalance FROM finance_journal_entries j WHERE source_ledger_entry_id = $1 ORDER BY id", [entryId])).rows as Array<{ memo: string; imbalance: number }>;

async function settledInvoiceWithEntry(claims: number[], extra: { title?: string; entryAmount?: number } = {}) {
  const userId = await newUser();
  const payer = await newUser();
  const entry = (await db.insert(financeLedgerEntriesTable).values({ userId, kind: "receivable", title: extra.title ?? "r", amount: extra.entryAmount ?? 100 }).returning())[0];
  const inv = await newInvoice(userId, { entryId: entry.id });
  const agreementIds: number[] = [];
  for (const amount of claims) {
    const a = await newClaim(inv, payer, amount);
    assert.equal((await verifyPaymentAgreement(userId, a.id, undefined, req)).status, "ok");
    agreementIds.push(a.id);
  }
  await sleep(300); // the repayment journal is posted just after the verify commits
  return { userId, payer, entry, inv, agreementIds };
}

test("appeal: cancelling a paid invoice with a reason reverses the payment, the entry balance, the repayment and its journal", async () => {
  const { userId, entry, inv, agreementIds } = await settledInvoiceWithEntry([100]);
  assert.equal((await invoiceRow(inv.id)).status, "paid");
  assert.equal((await entryRow(entry.id)).amount, 0);
  assert.deepEqual(await cancelInvoice(userId, inv.id), { status: "already_paid" }, "without a reason the refusal stands");

  assert.deepEqual(await cancelInvoice(userId, inv.id, { ...REASON, req }), { status: "ok", reversedAmount: 100 });
  const invoice = await invoiceRow(inv.id);
  assert.equal(invoice.status, "cancelled");
  assert.equal(invoice.paidAmount, 0);
  assert.ok(invoice.cancelledAt);
  const e = await entryRow(entry.id);
  assert.equal(e.amount, 100, "the money is owed again");
  assert.equal(e.status, "pending");
  assert.deepEqual(await repaymentsOf(entry.id), []);
  const a = await agreementRow(agreementIds[0]);
  assert.equal(a.status, "disputed");
  assert.match(a.disputeReason ?? "", /payment never arrived/);
  assert.equal(a.disputedBy, userId);
  const journals = await journalMemos(entry.id);
  assert.deepEqual(journals.map((j) => j.memo), ["Repayment — r", "Reversal of repayment — r"]);
  assert.ok(journals.every((j) => Math.abs(j.imbalance) < 1e-9), "both journals balance");
  const net = (await pool.query(
    "SELECT COALESCE(SUM(l.debit - l.credit),0)::float8 AS cash FROM finance_journal_lines l JOIN finance_journal_entries j ON j.id = l.journal_entry_id JOIN finance_accounts a ON a.id = l.account_id WHERE j.source_ledger_entry_id = $1 AND a.code = '1000'", [entry.id])).rows[0].cash;
  assert.equal(net, 0, "cash collected and cash reversed cancel out");
  await sleep(100);
  assert.ok((await eventTypes(inv.id)).includes("payment_reversed_cancelled"));
  assert.deepEqual(await cancelInvoice(userId, inv.id, REASON).then((r) => r.status), "ok", "a second appeal reverses nothing more");
  assert.equal((await entryRow(entry.id)).amount, 100);
  assert.equal((await journalMemos(entry.id)).length, 2);
});

test("appeal with several verified claims reverses all of them; another repayment on the entry stays and the status becomes partial", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const entry = (await db.insert(financeLedgerEntriesTable).values({ userId, kind: "receivable", title: "r", amount: 80 }).returning())[0];
  await db.insert(financeRepaymentsTable).values({ entryId: entry.id, amount: 20, isInterest: 0, notes: "cash handed over", paidAt: new Date() });
  const inv = await newInvoice(userId, { entryId: entry.id, amount: undefined });
  const c1 = await newClaim(inv, payer, 50);
  assert.equal((await verifyPaymentAgreement(userId, c1.id, undefined, req)).status, "ok");
  const c2 = await newClaim(inv, payer, 50);
  assert.equal((await verifyPaymentAgreement(userId, c2.id, undefined, req)).status, "ok");
  assert.equal((await entryRow(entry.id)).amount, 0);
  await sleep(300);

  assert.deepEqual(await cancelInvoice(userId, inv.id, REASON), { status: "ok", reversedAmount: 100 });
  const e = await entryRow(entry.id);
  assert.equal(e.amount, 100, "0 + 50 + 50");
  assert.equal(e.status, "partial", "the unrelated 20 repayment is still there");
  assert.deepEqual((await repaymentsOf(entry.id)).map((r) => r.notes), ["cash handed over"]);
  assert.deepEqual([(await agreementRow(c1.id)).status, (await agreementRow(c2.id)).status], ["disputed", "disputed"]);
  assert.equal((await invoiceRow(inv.id)).paidAmount, 0);
});

test("appeal on a partly paid invoice reverses only what was verified; claims never verified are left alone", async () => {
  const { userId, payer, entry, inv, agreementIds } = await settledInvoiceWithEntry([30]);
  assert.equal((await invoiceRow(inv.id)).status, "partially_paid");
  const pending = await newClaim(inv, payer, 20, "submitted");
  assert.deepEqual(await cancelInvoice(userId, inv.id, REASON), { status: "ok", reversedAmount: 30 });
  assert.equal((await entryRow(entry.id)).amount, 100);
  assert.equal((await agreementRow(agreementIds[0])).status, "disputed");
  assert.equal((await agreementRow(pending.id)).status, "submitted");
  assert.equal((await invoiceRow(inv.id)).paidAmount, 0);
});

test("appeal on an invoice without a linked entry cancels it and disputes the verified claim; nothing else is touched", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const inv = await newInvoice(userId);
  const a = await newClaim(inv, payer, 100);
  assert.equal((await verifyPaymentAgreement(userId, a.id, undefined, req)).status, "ok");
  assert.deepEqual(await cancelInvoice(userId, inv.id, REASON), { status: "ok", reversedAmount: 100 });
  const invoice = await invoiceRow(inv.id);
  assert.deepEqual([invoice.status, invoice.paidAmount], ["cancelled", 0]);
  assert.equal((await agreementRow(a.id)).status, "disputed");
});

test("appeal changes nothing for a non-owner, and an unsettled invoice with a reason is just cancelled", async () => {
  const { userId, entry, inv } = await settledInvoiceWithEntry([100]);
  const other = await newUser();
  assert.deepEqual(await cancelInvoice(other, inv.id, REASON), { status: "not_found" });
  assert.equal((await invoiceRow(inv.id)).status, "paid");
  assert.equal((await entryRow(entry.id)).amount, 0);

  const plain = await newInvoice(userId);
  assert.deepEqual(await cancelInvoice(userId, plain.id, REASON), { status: "ok" });
  assert.equal((await invoiceRow(plain.id)).status, "cancelled");
});

test("appeal is all or nothing: a failure while cancelling leaves the payment, the repayment, the entry and the journals as they were", async () => {
  const { userId, entry, inv, agreementIds } = await settledInvoiceWithEntry([100]);
  await assert.rejects(
    withFailingTrigger("finance_invoices", `NEW.id = ${inv.id} AND NEW.status = 'cancelled'`, () => cancelInvoice(userId, inv.id, REASON)),
    INJECTED,
  );
  assert.equal((await invoiceRow(inv.id)).status, "paid");
  assert.equal((await invoiceRow(inv.id)).paidAmount, 100);
  assert.equal((await entryRow(entry.id)).amount, 0);
  assert.equal((await repaymentsOf(entry.id)).length, 1);
  assert.equal((await agreementRow(agreementIds[0])).status, "creditor_verified");
  assert.equal((await journalMemos(entry.id)).length, 1, "no reversal journal survived the rollback");
});

test("appeal waits for an in-flight verify and then reverses it too", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const entry = (await db.insert(financeLedgerEntriesTable).values({ userId, kind: "receivable", title: "r", amount: 100 }).returning())[0];
  const inv = await newInvoice(userId, { entryId: entry.id });
  const a = await newClaim(inv, payer, 100);
  const held = await holdInvoice(inv.id, []);
  const verifying = verifyPaymentAgreement(userId, a.id, undefined, req);
  verifying.catch(() => {});
  await waitUntilBlocked();
  const cancelling = cancelInvoice(userId, inv.id, REASON);
  cancelling.catch(() => {});
  await sleep(150);
  await held.commit();
  assert.equal((await verifying).status, "ok");
  assert.deepEqual(await cancelling, { status: "ok", reversedAmount: 100 });
  assert.equal((await entryRow(entry.id)).amount, 100);
  assert.deepEqual(await repaymentsOf(entry.id), []);
  assert.equal((await invoiceRow(inv.id)).paidAmount, 0);
});
