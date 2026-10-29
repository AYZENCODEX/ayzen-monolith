import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Static authorization gate for every Finance HTTP route. It needs no database or
// network, so it runs anywhere `node --test --import tsx` works. It is a regression
// gate, not proof of authorization: it checks that each route (a) is authenticated
// or is an explicitly allowlisted token-gated public route and (b) derives the
// caller from the authenticated request and scopes by userId when it takes an id.
// Behavioral cross-user tests live in ledger-invariants.db.test.ts.

const routesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../routes");
const ROUTE_FILES = ["finance.ts", "finance-invoices.ts"];

// Public routes. Each is authorized by an unguessable token in the path and must stay
// on this list deliberately; adding a route here is a security review decision.
const PUBLIC_TOKEN_ROUTES = new Set([
  "GET /finance/receipt/:token",
  "GET /finance/receipt/:token/pdf",
  "POST /finance/ai/sms-webhook/:token",
  "GET /finance/invoices/public/:token",
  "GET /finance/invoices/public/:token/pdf",
  "GET /finance/payment-agreements/public/:token",
  "GET /finance/payment-agreements/public/:token/evidence-pdf",
]);

// Known authorization gaps, recorded so the gate can pass without hiding them. Each entry
// must still be a real gap (ratchet test below); delete the entry when the route is fixed.
// Currently empty: POST /finance/recurring/run-now (finding F1) now scopes its sweep to the
// caller and is covered by the dedicated test further down.
const KNOWN_CALLER_UNSCOPED_ROUTES = new Set<string>();

interface FinanceRoute {
  file: string;
  key: string;
  method: string;
  routePath: string;
  registration: string;
  body: string;
}

function loadRoutes(): FinanceRoute[] {
  const routes: FinanceRoute[] = [];
  for (const file of ROUTE_FILES) {
    const source = fs.readFileSync(path.join(routesDir, file), "utf8");
    const matches = [...source.matchAll(/^router\.(get|post|put|patch|delete)\(\s*"([^"]+)"/gm)];
    matches.forEach((match, index) => {
      const start = match.index ?? 0;
      const end = matches[index + 1]?.index ?? source.length;
      const body = source.slice(start, end);
      const arrow = body.indexOf("=>");
      routes.push({
        file,
        key: `${match[1].toUpperCase()} ${match[2]}`,
        method: match[1].toUpperCase(),
        routePath: match[2],
        registration: arrow === -1 ? body.slice(0, 400) : body.slice(0, arrow),
        body,
      });
    });
  }
  return routes;
}

// Owner taken from client-controlled input: req.body.userId, (req as any).body.userId,
// `userId: req.body...`, or `const { userId } = req.body`.
const OWNER_FROM_REQUEST = new RegExp(
  [
    String.raw`\breq(?:\s+as\s+[A-Za-z<>]+\))?\)?\.(?:body|query|params)\??\.userId\b`,
    String.raw`\buserId\s*:\s*\(?req\b[^,;\n]*\.(?:body|query|params)\b`,
    String.raw`\{[^}]*\buserId\b[^}]*\}\s*=\s*\(?req\b[^;\n]*\.(?:body|query|params)\b`,
  ].join("|"),
);

const routes = loadRoutes();

test("route scan finds the expected number of Finance routes", () => {
  assert.equal(routes.length, 109, "update this count and docs when Finance routes are added or removed");
  assert.equal(new Set(routes.map((r) => r.key)).size, routes.length, "duplicate route registrations");
});

test("every Finance route is authenticated unless allowlisted as a token-gated public route", () => {
  const unauthenticated = routes
    .filter((r) => !/\brequire(Session)?Auth\b/.test(r.registration))
    .map((r) => r.key)
    .sort();
  assert.deepEqual(unauthenticated, [...PUBLIC_TOKEN_ROUTES].sort());
});

test("allowlisted public routes are authorized by a path token", () => {
  for (const route of routes.filter((r) => PUBLIC_TOKEN_ROUTES.has(r.key))) {
    assert.match(route.routePath, /:token\b/, `${route.key} must carry a :token path parameter`);
    assert.match(route.body, /req\.params\.token|params\.token|\btoken\b/, `${route.key} must read the token`);
  }
});

test("authenticated Finance routes derive the caller from the authenticated request", () => {
  const offenders = routes
    .filter((r) => !PUBLIC_TOKEN_ROUTES.has(r.key) && !KNOWN_CALLER_UNSCOPED_ROUTES.has(r.key))
    .filter((r) => !/getRequestUser(Id)?\(|req\.user\b/.test(r.body))
    .map((r) => r.key);
  assert.deepEqual(offenders, []);
});

test("known caller-unscoped routes are still unscoped (delete the entry once fixed)", () => {
  for (const key of KNOWN_CALLER_UNSCOPED_ROUTES) {
    const route = routes.find((r) => r.key === key);
    assert.ok(route, `${key} no longer exists; remove it from KNOWN_CALLER_UNSCOPED_ROUTES`);
    assert.ok(
      !/getRequestUser(Id)?\(|req\.user\b/.test(route.body),
      `${key} now reads the caller; remove it from KNOWN_CALLER_UNSCOPED_ROUTES`,
    );
  }
});

test("authenticated Finance routes never take the owner from the request body, query or params", () => {
  const offenders = routes
    .filter((r) => !PUBLIC_TOKEN_ROUTES.has(r.key))
    .filter((r) => OWNER_FROM_REQUEST.test(r.body))
    .map((r) => r.key);
  assert.deepEqual(offenders, []);
});

test("authenticated Finance routes with path parameters scope their work by the caller's userId", () => {
  const offenders = routes
    .filter((r) => !PUBLIC_TOKEN_ROUTES.has(r.key))
    .filter((r) => /:[A-Za-z]+/.test(r.routePath))
    .filter((r) => !/authUser\.userId|getRequestUserId\(|\buserId\b/.test(r.body))
    .map((r) => r.key);
  assert.deepEqual(offenders, []);
});

// ─── Adapter thickness (extraction progress gate) ────────────────────────────

const REPORT_ADAPTERS: Record<string, string> = {
  "GET /finance/summary": "getFinanceSummary",
  "GET /finance/projections": "getFinanceProjections",
  "GET /finance/export": "getFinanceExportRows",
  "GET /finance/analytics": "getFinanceAnalytics",
  "GET /finance/insights": "getFinanceInsights",
  "GET /finance/reports/trial-balance": "getTrialBalanceReport",
  "GET /finance/reports/balance-sheet": "getBalanceSheetReport",
  "GET /finance/reports/income-statement": "getIncomeStatementReport",
  "GET /finance/reports/cash-flow": "getCashFlowReport",
  "GET /finance/reports/custom": "getCustomFinanceReport",
};
const DIRECT_DB = /\bdb\.(?:select|insert|update|delete|transaction|execute)\b/;

test("the 10 report routes stay thin adapters over application/reports", () => {
  for (const [key, fn] of Object.entries(REPORT_ADAPTERS)) {
    const route = routes.find((r) => r.key === key);
    assert.ok(route, `${key} not found`);
    assert.ok(!DIRECT_DB.test(route.body), `${key} must not call db.* directly`);
    assert.match(route.body, new RegExp(`\\b${fn}\\(`), `${key} must call ${fn}`);
  }
  const financeRoutes = fs.readFileSync(path.join(routesDir, "finance.ts"), "utf8");
  assert.match(financeRoutes, /from\s+["']\.\.\/finance\/application\/reports["']/);
});

// Ratchet: the number of routes that still call the database directly may only go down.
// Lower this constant in the same change that extracts a route into finance/application/*.
const MAX_ROUTES_WITH_DIRECT_DB = 2;

test("routes that call the database directly do not increase (ratchet)", () => {
  const count = routes.filter((r) => DIRECT_DB.test(r.body)).length;
  assert.ok(
    count <= MAX_ROUTES_WITH_DIRECT_DB,
    `${count} routes call db.* directly; the ceiling is ${MAX_ROUTES_WITH_DIRECT_DB}`,
  );
  if (count < MAX_ROUTES_WITH_DIRECT_DB) {
    assert.fail(`${count} < ${MAX_ROUTES_WITH_DIRECT_DB}: lower MAX_ROUTES_WITH_DIRECT_DB to ${count}`);
  }
});

test("POST /finance/recurring/run-now scopes the sweep to the authenticated caller (F1)", () => {
  const route = routes.find((r) => r.key === "POST /finance/recurring/run-now");
  assert.ok(route);
  assert.match(route.body, /getRequestUser\(req\)/);
  // WP-5a: the route calls runRecurringNow(authUser.userId); application/recurring.ts is the only
  // caller of the sweep on this path and must pass the same user scope.
  assert.match(route.body, /runRecurringNow\(\s*authUser\.userId\s*\)/);
  assert.doesNotMatch(route.body, /runFinanceRecurringSweep\(/, "route must not call the sweep directly");
  const app = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "application/recurring.ts"), "utf8");
  assert.match(app, /runFinanceRecurringSweep\(\s*\{\s*userId\s*\}\s*\)/);
  assert.doesNotMatch(app, /runFinanceRecurringSweep\(\s*\)/, "unscoped sweep call");
});

const entriesApp = () => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "application/entries.ts"), "utf8");
const fnBody = (source: string, name: string) => {
  const start = source.indexOf(`export async function ${name}`);
  assert.ok(start >= 0, `${name} not found`);
  const next = source.indexOf("\nexport ", start + 10);
  return source.slice(start, next === -1 ? undefined : next);
};

test("POST /finance/entries/:id/repayments goes through the atomic, idempotent recordRepayment (F4)", () => {
  const route = routes.find((r) => r.key === "POST /finance/entries/:id/repayments");
  assert.ok(route);
  // WP-5b: the route maps HTTP (header, 409, replay header); addRepayment owns the write path.
  assert.match(route.body, /\baddRepayment\(/);
  assert.match(route.body, /Idempotency-Key/);
  assert.match(route.body, /status\(409\)/);
  assert.match(route.body, /Idempotent-Replayed/);
  assert.doesNotMatch(route.body, /db\.insert\(financeRepaymentsTable\)/);
  const fn = fnBody(entriesApp(), "addRepayment");
  assert.match(fn, /\brecordRepayment\(/);
  assert.doesNotMatch(fn, /db\.insert\(financeRepaymentsTable\)/, "repayment row must be written inside recordRepayment's transaction");
  assert.doesNotMatch(fn, /applyPrincipalRepayment\(/, "balance change must be inside recordRepayment's transaction");
});

test("DELETE /finance/entries/:id removes the entry and its history in one transaction (F5)", () => {
  const route = routes.find((r) => r.key === "DELETE /finance/entries/:id");
  assert.ok(route);
  assert.match(route.body, /\bdeleteEntry\(/);
  assert.doesNotMatch(route.body, /\bdb\.delete\(/, "separate deletes outside the transaction");
  const fn = fnBody(entriesApp(), "deleteEntry");
  assert.match(fn, /\bdeleteLedgerEntryCascade\(/);
  assert.doesNotMatch(fn, /\bdb\.delete\(|\bdeleteJournalForEntry\(/);
});

test("installment payment and agreement verification are transactional and claim their row first (F6)", () => {
  const pay = routes.find((r) => r.key === "PUT /finance/amortization/:id/pay");
  assert.ok(pay);
  assert.match(pay.body, /\bpayAmortizationInstallment\(/);
  assert.doesNotMatch(pay.body, /\bdb\.(?:insert|update)\(/, "separate writes outside the transaction");

  const verify = routes.find((r) => r.key === "POST /finance/payment-agreements/:id/verify");
  assert.ok(verify);
  // WP-6b: the route maps HTTP (409 for the race loser); verifyPaymentAgreement owns the write path.
  assert.match(verify.body, /\bverifyPaymentAgreement\(/);
  assert.match(verify.body, /status\(409\)/);
  assert.doesNotMatch(verify.body, /\bdb\./, "the route must hold no database access");
  const fn = fnBody(agreementsApp(), "verifyPaymentAgreement");
  assert.match(fn, /db\.transaction\(/);
  assert.match(fn, /eq\(financePaymentAgreementsTable\.status, "passkey_confirmed"\)/, "agreement must be claimed conditionally");
  assert.match(fn, /applyPrincipalRepaymentTx\(tx,/);
  const tx = fn.slice(fn.indexOf("db.transaction("));
  assert.doesNotMatch(tx, /\bdb\.(?:insert|update|delete)\(/, "writes must use tx");
});

const agreementsApp = () => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "application/payment-agreements.ts"), "utf8");

// ─── WP-2 adapters ───────────────────────────────────────────────────────────

const WP2_ADAPTERS: Record<string, string> = {
  "GET /finance/investments": "getProjectInvestments",
  "GET /finance/parties": "listParties",
  "POST /finance/parties": "createParty",
  "PUT /finance/parties/:id": "updateParty",
  "DELETE /finance/parties/:id": "deleteParty",
  "GET /finance/currencies": "listCurrencyRates",
  "PUT /finance/currencies/:currency": "upsertCurrencyRate",
  "GET /finance/report-schedules": "listReportSchedules",
  "POST /finance/report-schedules": "createReportSchedule",
  "PUT /finance/report-schedules/:id": "updateReportSchedule",
  "DELETE /finance/report-schedules/:id": "deleteReportSchedule",
  "GET /finance/goals": "listGoals",
  "POST /finance/goals": "createGoal",
  "PUT /finance/goals/:id": "updateGoal",
  "POST /finance/goals/:id/contribute": "contributeToGoal",
  "DELETE /finance/goals/:id": "deleteGoal",
  "GET /finance/budgets": "listBudgetsWithSpent",
  "POST /finance/budgets": "upsertBudget",
  "DELETE /finance/budgets/:id": "deleteBudget",
};

test("the 19 WP-2 routes are thin adapters over finance/application/* (no direct db.*)", () => {
  for (const [key, fn] of Object.entries(WP2_ADAPTERS)) {
    const route = routes.find((r) => r.key === key);
    assert.ok(route, `${key} not found`);
    assert.ok(!DIRECT_DB.test(route.body), `${key} must not call db.* directly`);
    assert.match(route.body, new RegExp(`\\b${fn}\\(`), `${key} must call ${fn}`);
    assert.match(route.body, /authUser\.userId/, `${key} must scope by the authenticated user`);
  }
});

test("goal contributions are one atomic SQL statement, not a JS read-modify-write (F7)", () => {
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "application/goals-budgets.ts"), "utf8");
  const fn = source.slice(source.indexOf("export async function contributeToGoal"), source.indexOf("export async function deleteGoal"));
  assert.doesNotMatch(fn, /goal\.currentAmount\s*\+/, "amount must not be computed in JS from a previously read value");
  assert.match(fn, /isNull\(financeGoalsTable\.linkedAssetId\)/, "linked-asset guard must be part of the update");
  assert.match(fn, /CASE WHEN/);
});


// ─── WP-2b adapters ──────────────────────────────────────────────────────────

const WP2B_ADAPTERS: Record<string, string> = {
  "GET /finance/books": "listUserBooks",
  "POST /finance/books": "createBook",
  "PUT /finance/books/:id": "updateBook",
  "PUT /finance/books/:id/set-default": "setDefaultBook",
  "DELETE /finance/books/:id": "deleteBook",
  "GET /finance/accounts": "listAccounts",
  "POST /finance/accounts": "createAccount",
  "PUT /finance/accounts/:id": "updateAccount",
  "DELETE /finance/accounts/:id": "deleteAccount",
  "POST /finance/entries/:id/receipt": "mintEntryReceiptLink",
  "DELETE /finance/entries/:id/receipt": "revokeEntryReceiptLink",
  "POST /finance/ai/quick-entry/preview": "previewQuickEntries",
  "POST /finance/ai/quick-entry/commit": "commitQuickEntries",
  "POST /finance/ai/receipt-scan": "scanReceipt",
  "GET /finance/ai/sms-webhook-token": "getSmsWebhookInfo",
  "POST /finance/ai/sms-webhook-token/rotate": "rotateSmsWebhookInfo",
  "POST /finance/ai/sms-webhook/:token": "ingestSmsWebhook",
  "GET /finance/invoice-branding": "getInvoiceBranding",
  "PUT /finance/invoice-branding": "updateInvoiceBranding",
};
// Public token routes have no authenticated caller by design; they are adapters over receipts.ts.
const WP2B_PUBLIC_ADAPTERS: Record<string, string> = {
  "GET /finance/receipt/:token": "findByReceiptToken",
  "GET /finance/receipt/:token/pdf": "renderReceiptPdf",
};
const AI_READ_ONLY_DIRECT = ["POST /finance/ai/query", "GET /finance/ai/anomalies", "GET /finance/ai/recurring-suggestions"];

// loadRoutes() ends a route's body at the NEXT router.* call, so non-route code that follows the
// last route of a group (e.g. the ownership-helper block after DELETE /finance/books/:id) is
// attributed to it. The WP-2b gate therefore inspects the handler text only (up to its closing "});").
function handlerOnly(body: string): string {
  const end = body.search(/^\}\);\s*$/m);
  return end === -1 ? body : body.slice(0, end);
}

test("the 19 authenticated WP-2b routes are thin adapters over finance/application/* (no direct db.*)", () => {
  for (const [key, fn] of Object.entries(WP2B_ADAPTERS)) {
    const route = routes.find((r) => r.key === key);
    assert.ok(route, `${key} not found`);
    const handler = handlerOnly(route.body);
    assert.ok(!DIRECT_DB.test(handler), `${key} must not call db.* directly`);
    assert.match(handler, new RegExp(`\\b${fn}\\(`), `${key} must call ${fn}`);
    if (key !== "POST /finance/ai/sms-webhook/:token") {
      assert.match(handler, /authUser\.userId/, `${key} must scope by the authenticated user`);
    }
  }
});

test("the 2 public receipt routes and the 3 read-only AI routes hold no direct db.*", () => {
  for (const [key, fn] of Object.entries(WP2B_PUBLIC_ADAPTERS)) {
    const route = routes.find((r) => r.key === key);
    assert.ok(route, `${key} not found`);
    assert.ok(!DIRECT_DB.test(handlerOnly(route.body)), `${key} must not call db.* directly`);
    assert.match(route.body, new RegExp(`\\b${fn}\\(`), `${key} must call ${fn}`);
  }
  for (const key of AI_READ_ONLY_DIRECT) {
    const route = routes.find((r) => r.key === key);
    assert.ok(route, `${key} not found`);
    assert.ok(!DIRECT_DB.test(handlerOnly(route.body)), `${key} must not call db.* directly`);
  }
});

test("WP-2b owners never import routes/*, and the report-schedule cron has one owner", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const file of ["application/ai.ts", "application/books-accounts.ts", "application/receipts.ts", "application/invoice-branding.ts", "jobs/report-schedule.ts"]) {
    const source = fs.readFileSync(path.join(here, file), "utf8");
    assert.doesNotMatch(source, /from\s+["'](?:\.\.\/)+routes\//, `${file} must not import routes/*`);
  }
  const owner = fs.readFileSync(path.join(here, "jobs/report-schedule.ts"), "utf8");
  assert.match(owner, /export async function runFinanceReportSchedules/);
  assert.match(owner, /export function startFinanceReportScheduleCron/);
  assert.ok(!fs.existsSync(path.join(here, "../lib/finance-report-schedule-cron.ts")), "the legacy shim was removed in WP-8");
});

// ─── WP-4 adapters (assets, amortization, depreciation) ──────────────────────

const WP4_ADAPTERS: Record<string, string> = {
  "GET /finance/assets": "listAssets",
  "POST /finance/assets": "createAsset",
  "PUT /finance/assets/:id": "updateAsset",
  "DELETE /finance/assets/:id": "deleteAsset",
  "GET /finance/entries/:id/amortization": "listAmortization",
  "POST /finance/entries/:id/amortization/generate": "generateAmortization",
  "PUT /finance/amortization/:id/pay": "payAmortizationInstallment",
  "GET /finance/assets/:id/depreciation": "listDepreciation",
  "POST /finance/assets/:id/depreciation/generate": "generateDepreciation",
  "PUT /finance/depreciation/:id/post": "postDepreciationPeriod",
};

test("the 10 WP-4 asset/amortization/depreciation routes are thin adapters (no direct db.*, user-scoped)", () => {
  for (const [key, fn] of Object.entries(WP4_ADAPTERS)) {
    const route = routes.find((r) => r.key === key);
    assert.ok(route, `${key} not found`);
    const handler = handlerOnly(route.body);
    assert.ok(!DIRECT_DB.test(handler), `${key} must not call db.* directly`);
    assert.match(handler, new RegExp(`\\b${fn}\\(`), `${key} must call ${fn}`);
    assert.match(handler, /authUser\.userId/, `${key} must scope by the authenticated user`);
  }
});

test("WP-4 owners never import routes/*, the pure schedule math imports no DB or framework, and the legacy path is gone", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const file of ["application/assets.ts", "schedules/amortization.ts", "schedules/depreciation.ts", "domain/schedules.ts"]) {
    const source = fs.readFileSync(path.join(here, file), "utf8");
    assert.doesNotMatch(source, /from\s+["'](?:\.\.\/)+routes\//, `${file} must not import routes/*`);
  }
  const pure = fs.readFileSync(path.join(here, "domain/schedules.ts"), "utf8");
  const imports = [...pure.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
  assert.deepEqual(imports, ["./recurrence-dates"], "domain/schedules.ts may only import the pure date helper");
  assert.doesNotMatch(pure, /\bnew Date\(\)|Date\.now\(\)|Math\.random\(/, "pure math must not read the clock or randomness");
  assert.ok(!fs.existsSync(path.join(here, "../lib/finance-accounting.ts")), "the legacy shim was removed in WP-8");
});

// ─── WP-5a adapters (recurring rules, manual journal) ────────────────────────

const WP5A_ADAPTERS: Record<string, string> = {
  "GET /finance/recurring": "listRecurringRules",
  "POST /finance/recurring": "createRecurringRule",
  "PUT /finance/recurring/:id": "updateRecurringRule",
  "DELETE /finance/recurring/:id": "deleteRecurringRule",
  "POST /finance/recurring/run-now": "runRecurringNow",
  "GET /finance/journal": "listJournal",
  "GET /finance/journal/:id": "getJournalEntry",
  "POST /finance/journal": "createManualJournal",
  "DELETE /finance/journal/:id": "deleteManualJournal",
};

test("the 9 WP-5a recurring and journal routes are thin adapters (no direct db.*, user-scoped)", () => {
  for (const [key, fn] of Object.entries(WP5A_ADAPTERS)) {
    const route = routes.find((r) => r.key === key);
    assert.ok(route, `${key} not found`);
    const handler = handlerOnly(route.body);
    assert.ok(!DIRECT_DB.test(handler), `${key} must not call db.* directly`);
    assert.match(handler, new RegExp(`\\b${fn}\\(`), `${key} must call ${fn}`);
    assert.match(handler, /authUser\.userId/, `${key} must scope by the authenticated user`);
  }
});

test("manual journal delete is one transaction with an owner predicate (F13)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, "application/journal.ts"), "utf8");
  const fn = source.slice(source.indexOf("export async function deleteManualJournal"));
  assert.match(fn, /db\.transaction\(/);
  assert.match(fn, /\.for\("update"\)/);
  assert.doesNotMatch(fn, /\bdb\.delete\(/, "deletes must use tx");
  assert.match(fn, /financeJournalEntriesTable\.userId, userId/);
});

test("WP-5a owners never import routes/*; the recurring sweep has one owner", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const file of ["application/recurring.ts", "application/journal.ts", "jobs/recurring.ts"]) {
    const source = fs.readFileSync(path.join(here, file), "utf8");
    assert.doesNotMatch(source, /from\s+["'](?:\.\.\/)+routes\//, `${file} must not import routes/*`);
  }
  const owner = fs.readFileSync(path.join(here, "jobs/recurring.ts"), "utf8");
  assert.match(owner, /export async function runFinanceRecurringSweep/);
  assert.match(owner, /export function startFinanceRecurringCron/);
  assert.ok(!fs.existsSync(path.join(here, "../lib/finance-recurring-cron.ts")), "the legacy shim was removed in WP-8");
});

// ─── WP-5b adapters (entries, repayments, attachments, invoice lines, import) ─

const WP5B_ADAPTERS: Record<string, string> = {
  "GET /finance/entries": "listEntries",
  "POST /finance/entries": "createEntry",
  "PUT /finance/entries/:id": "updateEntry",
  "DELETE /finance/entries/:id": "deleteEntry",
  "GET /finance/entries/:id/repayments": "listRepayments",
  "POST /finance/entries/:id/repayments": "addRepayment",
  "GET /finance/entries/:id/attachments": "listEntryAttachments",
  "POST /finance/entries/:id/attachments": "uploadEntryAttachment",
  "GET /finance/entries/:id/attachments/:attachmentId": "getEntryAttachment",
  "DELETE /finance/entries/:id/attachments/:attachmentId": "deleteEntryAttachment",
  "GET /finance/entries/:id/invoice-lines": "listInvoiceLines",
  "PUT /finance/entries/:id/invoice-lines": "replaceInvoiceLines",
  "POST /finance/entries/import": "importEntriesCsv",
};

test("the 13 WP-5b entry routes are thin adapters (no direct db.*, user-scoped)", () => {
  for (const [key, fn] of Object.entries(WP5B_ADAPTERS)) {
    const route = routes.find((r) => r.key === key);
    assert.ok(route, `${key} not found`);
    const handler = handlerOnly(route.body);
    assert.ok(!DIRECT_DB.test(handler), `${key} must not call db.* directly`);
    assert.match(handler, new RegExp(`\\b${fn}\\(`), `${key} must call ${fn}`);
    assert.match(handler, /authUser\.userId/, `${key} must scope by the authenticated user`);
  }
});

test("every entry-scoped use case checks the caller owns the entry (WP-5b)", () => {
  const source = entriesApp();
  for (const name of ["listRepayments", "listEntryAttachments", "uploadEntryAttachment", "getEntryAttachment", "deleteEntryAttachment", "listInvoiceLines", "deleteEntry"]) {
    assert.match(fnBody(source, name), /assertEntryOwnership\(/, `${name} must check ownership first`);
  }
  for (const name of ["addRepayment", "replaceInvoiceLines", "updateEntry"]) {
    assert.match(fnBody(source, name), /financeLedgerEntriesTable\.userId, userId/, `${name} must read the entry with the caller's user_id`);
  }
});

test("invoice-line replacement is one transaction (F14)", () => {
  const fn = fnBody(entriesApp(), "replaceInvoiceLines");
  assert.match(fn, /db\.transaction\(/);
  const tx = fn.slice(fn.indexOf("db.transaction("), fn.indexOf("// Reconcile"));
  assert.doesNotMatch(tx, /\bdb\.(?:delete|insert|update)\(/, "writes inside the transaction must use tx");
  assert.match(tx, /tx\.delete\(financeInvoiceLinesTable\)/);
  assert.match(tx, /tx\.insert\(financeInvoiceLinesTable\)/);
  assert.match(tx, /tx\.update\(financeLedgerEntriesTable\)/);
});

test("WP-5b owner never imports routes/*", () => {
  assert.doesNotMatch(entriesApp(), /from\s+["'](?:\.\.\/)+routes\//);
});

// ─── WP-6a adapters (invoices) ───────────────────────────────────────────────

const WP6A_ADAPTERS: Record<string, string> = {
  "GET /finance/invoices": "listInvoices",
  "POST /finance/invoices": "createInvoice",
  "PUT /finance/invoices/:id/line-items": "updateInvoiceLineItems",
  "GET /finance/invoices/:id": "getInvoiceDetail",
  "GET /finance/invoices/:id/pdf": "streamCreditorInvoicePdf",
  "POST /finance/invoices/:id/send": "sendInvoice",
  "DELETE /finance/invoices/:id": "cancelInvoice",
  "POST /finance/invoices/:id/reopen": "reopenInvoice",
  "POST /finance/invoices/public/:token/submit-payment": "submitInvoicePayment",
};
// Public token routes: no authenticated caller by design.
const WP6A_PUBLIC_ADAPTERS: Record<string, string> = {
  "GET /finance/invoices/public/:token": "getPublicInvoiceView",
  "GET /finance/invoices/public/:token/pdf": "streamPublicInvoicePdf",
};

test("the 9 authenticated WP-6a invoice routes are thin adapters (no direct db.*, user-scoped)", () => {
  for (const [key, fn] of Object.entries(WP6A_ADAPTERS)) {
    const route = routes.find((r) => r.key === key);
    assert.ok(route, `${key} not found`);
    const handler = handlerOnly(route.body);
    assert.ok(!DIRECT_DB.test(handler), `${key} must not call db.* directly`);
    assert.match(handler, new RegExp(`\\b${fn}\\(`), `${key} must call ${fn}`);
    assert.match(handler, /authUser\.userId/, `${key} must scope by the authenticated user`);
  }
});

test("the 2 public WP-6a invoice routes hold no direct db.*", () => {
  for (const [key, fn] of Object.entries(WP6A_PUBLIC_ADAPTERS)) {
    const route = routes.find((r) => r.key === key);
    assert.ok(route, `${key} not found`);
    assert.ok(!DIRECT_DB.test(handlerOnly(route.body)), `${key} must not call db.* directly`);
    assert.match(route.body, new RegExp(`\\b${fn}\\(`), `${key} must call ${fn}`);
  }
});

test("the invoice line-item edit keeps its PDP ownership check ahead of the use case (WP-6a)", () => {
  const route = routes.find((r) => r.key === "PUT /finance/invoices/:id/line-items");
  assert.ok(route);
  const handler = handlerOnly(route.body);
  assert.ok(handler.indexOf("authorize(") >= 0 && handler.indexOf("authorize(") < handler.indexOf("updateInvoiceLineItems("), "PDP check must run before the use case");
  assert.ok(handler.indexOf("must be a non-empty array") < handler.indexOf("authorize("), "shape validation (400) must still precede ownership");
});

const here6a = path.dirname(fileURLToPath(import.meta.url));
const invoicesApp = () => fs.readFileSync(path.join(here6a, "application/invoices.ts"), "utf8");

test("invoice creation and line-item replacement are atomic (F15)", () => {
  const create = fnBody(invoicesApp(), "createInvoice");
  const tx = create.slice(create.indexOf("db.transaction("));
  assert.match(tx, /tx\.insert\(financeInvoicesTable\)/);
  assert.match(tx, /tx\.update\(financeInvoicesTable\)/);
  assert.match(tx, /replaceInvoiceLineItemsInTx\(tx,/);
  assert.doesNotMatch(tx, /\bdb\.(?:insert|update|delete)\(/, "writes inside the transaction must use tx");
  const store = fs.readFileSync(path.join(here6a, "invoices/store.ts"), "utf8");
  assert.match(store, /db\.transaction\(\(tx\) => replaceInvoiceLineItemsInTx\(tx,/);
  const rule = fs.readFileSync(path.join(here6a, "invoices/rule-invoice.ts"), "utf8");
  assert.match(rule, /db\.transaction\(/);
  assert.match(rule, /replaceInvoiceLineItemsInTx\(tx,/);
});

test("the invoice line-item edit runs under a row lock and re-checks the claim inside the transaction (F16)", () => {
  const fn = fnBody(invoicesApp(), "updateInvoiceLineItems");
  assert.match(fn, /db\.transaction\(/);
  assert.match(fn, /\.for\("update"\)/);
  const tx = fn.slice(fn.indexOf("db.transaction("));
  assert.ok(tx.indexOf(".for(\"update\")") < tx.indexOf("invoice.paidAmount > 0"), "lock before the paid/status check");
  assert.doesNotMatch(tx, /\bdb\.(?:insert|update|delete)\(/, "writes inside the transaction must use tx");
});

test("send, public view and reopen decide status in SQL, never from a previously read value (F17)", () => {
  const src = invoicesApp();
  const send = fnBody(src, "sendInvoice");
  assert.match(send, /CASE WHEN \$\{financeInvoicesTable\.status\} IN \('sent', 'viewed'\)/);
  assert.doesNotMatch(send, /status:\s*invoice\.status/, "status must not be derived from the earlier read");
  assert.doesNotMatch(send, /sentViaEmail:\s*sentEmail \? 1 : invoice\./, "flags must not be written back from the earlier read");
  const reopen = fnBody(src, "reopenInvoice");
  assert.match(reopen, /eq\(financeInvoicesTable\.status, "disputed"\)/, "reopen must claim only a still-disputed invoice");
  assert.match(reopen, /CASE WHEN \$\{financeInvoicesTable\.paidAmount\} > 0/);
  const view = fnBody(src, "getPublicInvoiceView");
  assert.match(view, /eq\(financeInvoicesTable\.status, "sent"\)/, "viewed flip must be conditional on status sent");
});

test("a payment claim is one transaction under the invoice row lock and must be positive (F18)", () => {
  const fn = fnBody(invoicesApp(), "submitInvoicePayment");
  const tx = fn.slice(fn.indexOf("db.transaction("), fn.indexOf("if (outcome.status !== \"ok\")"));
  assert.match(tx, /\.for\("update"\)/);
  assert.match(tx, /tx\.insert\(financePaymentAgreementsTable\)/);
  assert.match(tx, /tx\.update\(financeInvoicesTable\)/);
  assert.doesNotMatch(tx, /\bdb\.(?:insert|update|delete)\(/, "writes inside the transaction must use tx");
  assert.match(tx, /Number\.isFinite\(claimAmount\) \|\| claimAmount <= 0/);
  const route = routes.find((r) => r.key === "POST /finance/invoices/public/:token/submit-payment");
  assert.ok(route);
  assert.match(route.body, /invalid_amount/);
});

test("WP-6a owners never import routes/*; the legacy invoice libs are gone", () => {
  for (const file of ["application/invoices.ts", "invoices/links.ts", "invoices/events.ts", "invoices/store.ts", "invoices/rule-invoice.ts", "invoices/pdf.ts", "invoices/format.ts"]) {
    const source = fs.readFileSync(path.join(here6a, file), "utf8");
    assert.doesNotMatch(source, /from\s+["'](?:\.\.\/)+routes\//, `${file} must not import routes/*`);
  }
  for (const legacy of ["../lib/finance-invoice.ts", "../lib/invoice-pdf.ts"]) {
    assert.ok(!fs.existsSync(path.join(here6a, legacy)), `${legacy} was removed in WP-8`);
  }
});

// ─── WP-6b adapters (payment agreements) ─────────────────────────────────────

const WP6B_ADAPTERS: Record<string, string> = {
  "POST /finance/payment-agreements/public/:token/passkey/options": "createPasskeyOptions",
  "POST /finance/payment-agreements/public/:token/passkey/verify": "confirmAgreementWithPasskey",
  "POST /finance/payment-agreements/:id/verify": "verifyPaymentAgreement",
  "POST /finance/payment-agreements/:id/dispute": "disputePaymentAgreement",
};
// Public token routes: no authenticated caller by design.
const WP6B_PUBLIC_ADAPTERS: Record<string, string> = {
  "GET /finance/payment-agreements/public/:token": "getPublicAgreementView",
  "GET /finance/payment-agreements/public/:token/evidence-pdf": "streamAgreementEvidencePdf",
};

test("the 4 authenticated WP-6b payment-agreement routes are thin adapters (no direct db.*, user-scoped)", () => {
  for (const [key, fn] of Object.entries(WP6B_ADAPTERS)) {
    const route = routes.find((r) => r.key === key);
    assert.ok(route, `${key} not found`);
    const handler = handlerOnly(route.body);
    assert.ok(!DIRECT_DB.test(handler), `${key} must not call db.* directly`);
    assert.match(handler, new RegExp(`\\b${fn}\\(`), `${key} must call ${fn}`);
    assert.match(handler, /authUser\.userId/, `${key} must scope by the authenticated user`);
  }
});

test("the 2 public WP-6b payment-agreement routes hold no direct db.*", () => {
  for (const [key, fn] of Object.entries(WP6B_PUBLIC_ADAPTERS)) {
    const route = routes.find((r) => r.key === key);
    assert.ok(route, `${key} not found`);
    assert.ok(!DIRECT_DB.test(handlerOnly(route.body)), `${key} must not call db.* directly`);
    assert.match(route.body, new RegExp(`\\b${fn}\\(`), `${key} must call ${fn}`);
  }
});

test("the agreement routes keep their PDP ownership checks ahead of the use case (WP-6b)", () => {
  const order: Array<[string, string, string]> = [
    ["POST /finance/payment-agreements/public/:token/passkey/options", "finance.payment_agreement.passkey_options", "createPasskeyOptions("],
    ["POST /finance/payment-agreements/public/:token/passkey/verify", "finance.payment_agreement.passkey_verify", "confirmAgreementWithPasskey("],
    ["POST /finance/payment-agreements/public/:token/passkey/verify", "finance.payment_agreement.passkey_challenge.verify", "confirmAgreementWithPasskey("],
    ["POST /finance/payment-agreements/:id/verify", "finance.payment_agreement.verify", "verifyPaymentAgreement("],
    ["POST /finance/payment-agreements/:id/dispute", "finance.payment_agreement.dispute", "disputePaymentAgreement("],
  ];
  for (const [key, action, call] of order) {
    const route = routes.find((r) => r.key === key);
    assert.ok(route, `${key} not found`);
    const handler = handlerOnly(route.body);
    assert.ok(handler.includes(`"${action}"`), `${key} must keep the ${action} check`);
    assert.ok(handler.indexOf(`"${action}"`) < handler.indexOf(call), `${key}: ${action} must run before ${call}`);
  }
  const dispute = routes.find((r) => r.key === "POST /finance/payment-agreements/:id/dispute");
  assert.ok(dispute);
  const d = handlerOnly(dispute.body);
  assert.ok(d.indexOf("A reason is required") < d.indexOf("authorize("), "the reason validation (400) must still precede ownership");
});

test("passkey confirmation only applies to a still-submitted agreement and keeps WebAuthn errors apart from database errors (F19)", () => {
  const fn = fnBody(agreementsApp(), "confirmAgreementWithPasskey");
  const tx = fn.slice(fn.indexOf("db.transaction("));
  assert.match(tx, /tx\.update\(passkeyCredentialsTable\)/);
  assert.match(tx, /eq\(financePaymentAgreementsTable\.status, "submitted"\)/, "the flip must be conditional on status submitted");
  assert.doesNotMatch(tx, /\bdb\.(?:insert|update|delete)\(/, "writes inside the transaction must use tx");
  // The try/catch wraps the WebAuthn check only; the database work comes after it.
  assert.ok(fn.indexOf("} catch") < fn.indexOf("db.transaction("), "the catch must not cover the database writes");
  const route = routes.find((r) => r.key === "POST /finance/payment-agreements/public/:token/passkey/verify");
  assert.ok(route);
  assert.match(route.body, /not_submitted/);
});

test("dispute is one transaction under the invoice lock, claims the agreement and never un-settles an invoice (F20)", () => {
  const fn = fnBody(agreementsApp(), "disputePaymentAgreement");
  const tx = fn.slice(fn.indexOf("db.transaction("));
  assert.match(tx, /\.for\("update"\)/);
  assert.ok(tx.indexOf('.for("update")') < tx.indexOf("tx.update(financePaymentAgreementsTable)"), "lock before the write");
  assert.match(tx, /tx\.update\(financePaymentAgreementsTable\)/);
  assert.match(tx, /tx\.update\(financeInvoicesTable\)/);
  assert.match(tx, /IN \('paid', 'creditor_verified', 'cancelled'\)/, "settled or cancelled invoices keep their status");
  assert.doesNotMatch(tx, /\bdb\.(?:insert|update|delete)\(/, "writes inside the transaction must use tx");
});

test("verify locks the invoice before the agreement and refuses a claim larger than the remaining balance (F21)", () => {
  const fn = fnBody(agreementsApp(), "verifyPaymentAgreement");
  const tx = fn.slice(fn.indexOf("db.transaction("));
  const first = tx.indexOf('.for("update")');
  const second = tx.indexOf('.for("update")', first + 1);
  assert.ok(first > 0 && second > first, "both rows are locked");
  assert.ok(tx.indexOf("financeInvoicesTable") < tx.indexOf("financePaymentAgreementsTable"), "invoice is locked first (same order as dispute and submit)");
  assert.ok(tx.indexOf("exceeds_remaining") < tx.indexOf("tx.update(financePaymentAgreementsTable)"), "the balance check runs before the claim");
  assert.match(tx, /agreement\.amount > remaining \+ 0\.01/);
  const route = routes.find((r) => r.key === "POST /finance/payment-agreements/:id/verify");
  assert.ok(route);
  assert.match(route.body, /exceeds_remaining/);
});

test("cancelling an invoice is one transaction under the row lock and refuses a settled invoice (F22)", () => {
  const fn = fnBody(invoicesApp(), "cancelInvoice");
  assert.match(fn, /db\.transaction\(/);
  assert.match(fn, /\.for\("update"\)/);
  assert.match(fn, /invoice\.status === "paid" \|\| invoice\.status === "creditor_verified"/);
  const route = routes.find((r) => r.key === "DELETE /finance/invoices/:id");
  assert.ok(route);
  assert.match(route.body, /already_paid/);
});

test("a settled invoice is cancelled only as an appeal with a reason, and the reversal is atomic under the row lock (F22 appeal)", () => {
  const fn = fnBody(invoicesApp(), "cancelInvoice");
  assert.match(fn, /settled && !reversal/, "no reason: the refusal stands");
  assert.match(fn, /status: "disputed"[\s\S]*disputeReason/, "verified claims are disputed with the creditor's reason");
  assert.match(fn, /tx\.delete\(financeRepaymentsTable\)/, "the repayment verify posted is removed");
  assert.match(fn, /postRepaymentReversalJournalInTx\(tx,/, "its journal is reversed inside the same transaction");
  const route = routes.find((r) => r.key === "DELETE /finance/invoices/:id");
  assert.ok(route);
  assert.match(route.body, /reason must be 3 to 500 characters/);
  assert.match(route.body, /reversePayments: reason \? \{ reason \} : undefined/, "reversal is requested only with a validated reason");
  assert.doesNotMatch(route.body, /reversePayments: true/);
});

test("submit counts pending claims under the invoice lock and the route answers 409 (F21 follow-up)", () => {
  const fn = fnBody(invoicesApp(), "submitInvoicePayment");
  assert.match(fn, /\.for\("update"\)/);
  assert.match(fn, /inArray\(financePaymentAgreementsTable\.status, \["submitted", "passkey_confirmed"\]\)/);
  assert.match(fn, /pending_claims/);
  const route = routes.find((r) => r.key === "POST /finance/invoices/public/:token/submit-payment");
  assert.ok(route);
  assert.match(route.body, /case "pending_claims": res\.status\(409\)/);
});

test("WP-6b owner never imports routes/*", () => {
  assert.doesNotMatch(agreementsApp(), /from\s+["'](?:\.\.\/)+routes\//, "application/payment-agreements.ts must not import routes/*");
});

// ---- WP-7: fees, jobs and the wallet bridge (F23 to F26) -------------------------------------------------------------
const here7 = path.dirname(fileURLToPath(import.meta.url));
const read7 = (rel: string) => fs.readFileSync(path.join(here7, rel), "utf8");
// Module-private helpers are not exported, so match `async function name` up to the next top-level declaration.
const privateFnBody = (source: string, name: string) => {
  const start = source.indexOf(`async function ${name}`);
  assert.ok(start >= 0, `${name} not found`);
  const rest = source.slice(start + 10);
  const next = rest.search(/\n(?:export |async function |function |class |let |const )/);
  return source.slice(start, next === -1 ? undefined : start + 10 + next);
};

test("a late-fee accrual is one conditional transaction that books its journal, and a failed journal rolls it back (F23)", () => {
  const source = read7("fees/late-fees.ts");
  const fn = privateFnBody(source, "accrueLateFee");
  assert.match(fn, /db\.transaction\(/);
  assert.match(fn, /notInArray\(financeLedgerEntriesTable\.status/, "a settled entry is not charged");
  assert.match(fn, /lateFeeLastCalcAt/, "the claim is conditional on the calc timestamp the sweep read");
  assert.match(fn, /isNull\(financeLedgerEntriesTable\.lateFeeLastCalcAt\)/);
  assert.match(fn, /postLateFeeAccrualJournalInTx\(tx,/, "the journal is posted inside the same transaction");
  assert.match(fn, /throw new LateFeeJournalError/, "an unpostable journal aborts the accrual");
  assert.doesNotMatch(source, /postLateFeeAccrualJournal\([^)]*\)\.catch/, "no fire-and-forget journal");
  assert.doesNotMatch(source, /where\(sql`id = /, "no unconditional raw-id writes");
});

test("the pending to overdue flip never overwrites a newer status (F23)", () => {
  const source = read7("fees/late-fees.ts");
  assert.match(source, /eq\(financeLedgerEntriesTable\.status, "pending"\)\)\);/);
});

test("the due-date reminder claims the entry before notifying and releases the claim on failure (F24)", () => {
  const source = read7("jobs/reminder.ts");
  const sweep = fnBody(source, "runFinanceReminderSweep");
  const claim = sweep.indexOf("isNull(financeLedgerEntriesTable.remindedAt)");
  assert.ok(sweep.indexOf(".returning(") > 0);
  assert.ok(sweep.indexOf("await notify(") > sweep.indexOf(".returning("), "claim first, notify second");
  assert.ok(claim >= 0);
  assert.match(sweep, /date_trunc\('milliseconds', \$\{financeLedgerEntriesTable\.dueDate\}\) = \$\{e\.dueDate!\.toISOString\(\)\}::timestamp/, "a changed due date is not claimed");
  assert.match(sweep, /remindedAt: null/, "a failed notification releases the claim");
  assert.match(sweep, /catch \(err: any\)[\s\S]*Failed to send finance due-date reminder/, "one entry failing does not abort the sweep");
});

test("the overdue invoice reminder claims the invoice before sending and restores the claim when nothing was delivered (F25)", () => {
  const sweep = fnBody(read7("jobs/invoice-reminder.ts"), "runFinanceInvoiceReminderSweep");
  const claim = sweep.indexOf("reminderCount: sql`${financeInvoicesTable.reminderCount} + 1`");
  assert.ok(claim > 0, "the counter is bumped by the claim");
  assert.ok(sweep.indexOf("await sendEmail(") > claim && sweep.indexOf("await sendTelegram(") > claim, "claim before any send");
  assert.match(sweep, /\.returning\(\{ id: financeInvoicesTable\.id \}\)/);
  assert.match(sweep, /claimed && !delivered/);
  assert.match(sweep, /reminderCount: sql`\$\{financeInvoicesTable\.reminderCount\} - 1`/, "the restore undoes the counter bump");
  assert.match(sweep, /eq\(financeInvoicesTable\.lastReminderAt, now\)/, "only our own claim is restored");
});

test("the wallet bridge inserts the entry and posts its journal in one transaction (F26)", () => {
  const source = read7("integrations/wallet-bridge.ts");
  const fn = privateFnBody(source, "insertEntryWithJournal");
  assert.match(fn, /db\.transaction\(/);
  assert.match(fn, /postEntryJournalInTx\(tx, entry\)/);
  assert.match(fn, /throw new WalletJournalError/);
  assert.doesNotMatch(source, /db\.insert\(financeLedgerEntriesTable\)/, "no insert outside the transaction");
});

test("the WP-7 job and fee owners never import routes/* or the legacy lib shims", () => {
  for (const rel of ["fees/late-fees.ts", "jobs/late-fee.ts", "jobs/reminder.ts", "jobs/invoice-reminder.ts", "jobs/digest.ts", "jobs/networth.ts", "integrations/wallet-bridge.ts"]) {
    const source = read7(rel);
    assert.doesNotMatch(source, /from\s+["'](?:\.\.\/)+routes\//, `${rel} must not import routes/*`);
    assert.doesNotMatch(source, /from\s+["'][^"']*lib\/finance-/, `${rel} must not import a legacy lib/finance-* shim`);
  }
});

test("every WP-7 sweep can be scoped and clocked for tests, and the scheduled call passes no options", () => {
  assert.match(read7("fees/late-fees.ts"), /options\.userIds \? inArray\(/);
  assert.match(read7("jobs/reminder.ts"), /options\.userIds \? inArray\(/);
  assert.match(read7("jobs/invoice-reminder.ts"), /deps\.userIds \? inArray\(/);
  assert.match(read7("jobs/late-fee.ts"), /runFinanceLateFeeSweep\(\)\.catch/);
  assert.match(read7("jobs/reminder.ts"), /runFinanceReminderSweep\(\)\.catch/);
  assert.match(read7("jobs/invoice-reminder.ts"), /runFinanceInvoiceReminderSweep\(\)\.catch/);
});

test("the late-fee sweep rounds fees to cents before the one-cent threshold (WP-7 owner decision)", () => {
  const sweep = fnBody(read7("fees/late-fees.ts"), "runFinanceLateFeeSweep");
  assert.match(sweep, /const fee = roundLateFee\(await computeAccrual\(/);
  assert.ok(sweep.indexOf("roundLateFee(") < sweep.indexOf("fee <= 0.01"));
});

test("overdue invoice nudges skip invoices whose payment claim awaits review (WP-7 owner decision)", () => {
  const source = read7("jobs/invoice-reminder.ts");
  for (const status of ["payment_submitted", "agreement_confirmed", "creditor_verified", "disputed", "paid"]) {
    assert.match(source, new RegExp(`"${status}"`), `${status} must be excluded`);
  }
  assert.doesNotMatch(source.slice(source.indexOf("const SETTLED_STATUSES"), source.indexOf("];", source.indexOf("const SETTLED_STATUSES"))), /partially_paid/);
});

test("the wallet repair journals each orphan under a row lock in its own transaction, re-checking for a journal (F26)", () => {
  const fn = fnBody(read7("integrations/wallet-bridge.ts"), "repairWalletEntriesWithoutJournal");
  assert.match(fn, /db\.transaction\(/);
  assert.match(fn, /\.for\("update"\)/);
  assert.match(fn, /journaled meanwhile/);
  assert.match(fn, /postEntryJournalInTx\(tx, entry\)/);
  assert.match(fn, /notExists\(/, "only entries without any journal are selected");
});

// ---- WP-8: shims retired ----------------------------------------------------------------------------------------------
const here8 = path.dirname(fileURLToPath(import.meta.url));
const walkTs = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? (e.name === "node_modules" ? [] : walkTs(path.join(dir, e.name))) : /\.(ts|mjs)$/.test(e.name) ? [path.join(dir, e.name)] : []);

test("no lib/finance-* shim and no lib/invoice-pdf remain (WP-8)", () => {
  const libDir = path.join(here8, "../lib");
  const left = fs.readdirSync(libDir).filter((n) => (/^finance-/.test(n) && !/^finance-accounting\.db(-runner\.mjs|\.test\.ts)$/.test(n)) || n === "invoice-pdf.ts");
  assert.deepEqual(left, []);
});

test("nothing imports a removed lib/finance-* path, tests included (WP-8)", () => {
  const names = "finance-(?:accounting|ai|digest-cron|invoice|invoice-reminder-cron|late-fee-cron|networth|networth-cron|notify|recurring-cron|reminder-cron|report-schedule-cron|wallet-bridge)|invoice-pdf";
  const viaLib = new RegExp(`from\\s+["'][^"']*\\/lib\\/(?:${names})["']|import\\(["'][^"']*\\/lib\\/(?:${names})["']\\)`);
  const sibling = new RegExp(`from\\s+["']\\.\\/(?:${names})["']`); // only meaningful for files that live in lib/
  const libDir = path.join(here8, "../lib") + path.sep;
  const offenders = walkTs(path.join(here8, "..")).filter((f) => !f.endsWith("route-security.test.ts")).filter((f) => {
    const src = fs.readFileSync(f, "utf8");
    return viaLib.test(src) || (f.startsWith(libDir) && sibling.test(src));
  });
  assert.deepEqual(offenders.map((f) => path.relative(path.join(here8, ".."), f)), []);
});

test("the Finance routes import Finance code only through finance/application/* (WP-8)", () => {
  for (const file of ROUTE_FILES) {
    const source = fs.readFileSync(path.join(routesDir, file), "utf8");
    const offenders = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1])
      .filter((spec) => /(^|\/)finance\//.test(spec) && !/^\.\.\/finance\/application\//.test(spec));
    assert.deepEqual(offenders, [], `${file} imports Finance code outside application/*`);
  }
});

test("every application entry point the routes need is declared or re-exported by an application module (WP-8)", () => {
  const need: Record<string, string[]> = {
    "application/networth.ts": ["computeNetWorthBreakdown", "snapshotNetWorth", "listNetWorthHistory", "syncGoalProgress"],
    "application/payment-methods.ts": ["createFinancePaymentMethod", "deleteFinancePaymentMethod", "listFinancePaymentMethods", "resetFinancePaymentMethodDefaults", "updateFinancePaymentMethod"],
    "application/ai.ts": ["detectAnomalies", "answerFinanceQuery", "detectRecurringCandidates"],
    "application/assets.ts": ["payAmortizationInstallment"],
    "application/invoices.ts": ["iso"],
  };
  for (const [file, names] of Object.entries(need)) {
    const source = fs.readFileSync(path.join(here8, file), "utf8");
    for (const name of names) assert.match(source, new RegExp(`\\b${name}\\b`), `${file} must expose ${name}`);
  }
});
