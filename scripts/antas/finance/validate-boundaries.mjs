import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const serverRoot = path.join(root, "artifacts/api-server/src");
const financeServiceRoot = path.join(root, "services/finance/src");
const domainRoot = path.join(serverRoot, "finance/domain");
const validatorPath = fileURLToPath(import.meta.url);
const ciWorkflowPath = path.join(root, ".github/workflows/ci.yml");
const evidencePath = path.join(root, "reports/antas/finance/fin-01-dependency-scan.json");
const findings = [];

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

function isSource(file) {
  return /\.(?:mjs|cjs|js|mts|cts|ts|tsx|jsx)$/.test(file);
}

function isTest(file) {
  return /\.(?:test|spec)\.[^.]+$/.test(file);
}

function readSource(file) {
  return fs.readFileSync(file, "utf8");
}

function importedSpecifiers(source) {
  const values = new Set();
  for (const match of source.matchAll(/\bfrom\s*["']([^"']+)["']/g)) values.add(match[1]);
  for (const match of source.matchAll(/\bimport\s*["']([^"']+)["']/g)) values.add(match[1]);
  for (const match of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) values.add(match[1]);
  return [...values];
}

function resolveLocalImport(importer, specifier, sourceFiles) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(importer), specifier);
  const candidates = [
    base,
    ...[".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs"].map((extension) => `${base}${extension}`),
    ...["index.ts", "index.tsx", "index.js", "index.mjs"].map((name) => path.join(base, name)),
  ];
  return candidates.find((candidate) => sourceFiles.has(candidate)) ?? null;
}

function stronglyConnectedComponents(graph) {
  let nextIndex = 0;
  const indices = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];

  function visit(node) {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const dependency of graph.get(node) ?? []) {
      if (!indices.has(dependency)) {
        visit(dependency);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(dependency)));
      } else if (onStack.has(dependency)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(dependency)));
      }
    }

    if (lowLinks.get(node) === indices.get(node)) {
      const component = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      components.push(component);
    }
  }

  for (const node of graph.keys()) {
    if (!indices.has(node)) visit(node);
  }
  return components;
}

const allServerSources = walk(serverRoot).filter((file) => isSource(file) && !isTest(file));
const financeServiceSources = walk(financeServiceRoot).filter((file) => isSource(file) && !isTest(file));
const allFinanceImplementationSources = [...allServerSources, ...financeServiceSources];
const sourceFileSet = new Set(allFinanceImplementationSources);
const graph = new Map();
for (const file of allFinanceImplementationSources) {
  const dependencies = importedSpecifiers(readSource(file))
    .map((specifier) => resolveLocalImport(file, specifier, sourceFileSet))
    .filter(Boolean);
  graph.set(file, dependencies);
}

const financeSources = allServerSources.filter((file) => {
  const sourcePath = relative(file);
  return sourcePath.includes("/src/finance/")
    || sourcePath.includes("/src/lib/finance-")
    || sourcePath.endsWith("/src/lib/invoice-pdf.ts")
    || sourcePath.endsWith("/src/lib/receipt-theme.ts")
    || sourcePath.includes("/src/routes/finance");
});
const financeSourcesIncludingService = [...financeSources, ...financeServiceSources];
const financeSourceSet = new Set(financeSourcesIncludingService);

const forbiddenDomainImports = [];
for (const file of walk(domainRoot).filter((candidate) => isSource(candidate) && !isTest(candidate))) {
  for (const specifier of importedSpecifiers(readSource(file))) {
    const target = resolveLocalImport(file, specifier, sourceFileSet);
    const isDomainSibling = target && target.startsWith(`${domainRoot}${path.sep}`);
    if (!isDomainSibling) forbiddenDomainImports.push({ file: relative(file), specifier });
  }
}
if (forbiddenDomainImports.length) {
  findings.push({
    check: "finance-domain-purity",
    message: "Pure Finance domain modules must not import infrastructure, framework, or external modules.",
    imports: forbiddenDomainImports,
  });
}

const ownershipSymbols = ["computeLineItemsTotal", "computeInvoiceTotals"];
const declarationOwners = Object.fromEntries(ownershipSymbols.map((symbol) => {
  const declarationPattern = new RegExp(`\\b(?:function|const|let|var)\\s+${symbol}\\b`);
  return [symbol, allFinanceImplementationSources.filter((file) => declarationPattern.test(readSource(file))).map(relative)];
}));
for (const [symbol, owners] of Object.entries(declarationOwners)) {
  const expected = "artifacts/api-server/src/finance/domain/invoice-totals.ts";
  if (owners.length !== 1 || owners[0] !== expected) {
    findings.push({
      check: "single-invoice-calculation-owner",
      symbol,
      expectedOwner: expected,
      actualOwners: owners,
    });
  }
}

// WP-8: the lib/finance-invoice.ts compatibility adapter checks were removed with the shim.

const formatOwnershipSymbols = ["formatInvoiceNumber", "amountInWords"];
const formatOwner = "artifacts/api-server/src/finance/domain/invoice-format.ts";
const formatDeclarationOwners = Object.fromEntries(formatOwnershipSymbols.map((symbol) => {
  const declarationPattern = new RegExp(`\\b(?:function|const|let|var)\\s+${symbol}\\b`);
  return [symbol, allFinanceImplementationSources.filter((file) => declarationPattern.test(readSource(file))).map(relative)];
}));
for (const [symbol, owners] of Object.entries(formatDeclarationOwners)) {
  if (owners.length !== 1 || owners[0] !== formatOwner) {
    findings.push({
      check: "single-invoice-format-owner",
      symbol,
      expectedOwner: formatOwner,
      actualOwners: owners,
    });
  }
}

const dateOwner = "artifacts/api-server/src/finance/domain/recurrence-dates.ts";
const dateOwnershipSymbols = ["addMonthsClamped", "advanceRecurringDate"];
// Former private copies; none may be re-declared in any Finance implementation source.
const retiredDateSymbols = ["addMonths", "setMonthClamped", "advance"];
const declares = (file, symbol) => new RegExp(`\\b(?:function|const|let|var)\\s+${symbol}\\b`).test(readSource(file));
const dateDeclarationOwners = Object.fromEntries(dateOwnershipSymbols.map((symbol) => [
  symbol,
  allFinanceImplementationSources.filter((file) => declares(file, symbol)).map(relative),
]));
for (const [symbol, owners] of Object.entries(dateDeclarationOwners)) {
  if (owners.length !== 1 || owners[0] !== dateOwner) {
    findings.push({ check: "single-recurrence-date-owner", symbol, expectedOwner: dateOwner, actualOwners: owners });
  }
}
const financeLibSources = allFinanceImplementationSources.filter((file) => /\/lib\/finance-[^/]+\.ts$/.test(file));
const retiredDateDeclarations = retiredDateSymbols.flatMap((symbol) => financeLibSources
  .filter((file) => declares(file, symbol))
  .map((file) => ({ symbol, file: relative(file) })));
if (retiredDateDeclarations.length) {
  findings.push({ check: "retired-recurrence-date-copies", declarations: retiredDateDeclarations });
}
// file -> [symbol it must import, import specifier as written in that file].
// WP-4: the month-arithmetic consumer moved from lib/finance-accounting.ts to the pure schedule math.
const dateConsumers = {
  "artifacts/api-server/src/finance/domain/schedules.ts": ["addMonthsClamped", "./recurrence-dates"],
  "artifacts/api-server/src/finance/jobs/recurring.ts": ["advanceRecurringDate", "../domain/recurrence-dates"],
};
const dateConsumerWiring = Object.fromEntries(Object.entries(dateConsumers).map(([file, [symbol, specifier]]) => {
  const source = fs.existsSync(path.join(root, file)) ? readSource(path.join(root, file)) : "";
  const imported = [...source.matchAll(/\bimport\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/gs)]
    .some((match) => match[2] === specifier
      && match[1].split(",").some((name) => name.trim() === symbol));
  return [file, { symbol, importsOwner: imported }];
}));
if (Object.values(dateConsumerWiring).some((entry) => !entry.importsOwner)) {
  findings.push({ check: "recurrence-date-consumer-wiring", consumers: dateConsumerWiring });
}

const extractedOwnerContracts = [
  {
    name: "networth",
    owner: "artifacts/api-server/src/finance/networth/networth.ts",
    legacy: "artifacts/api-server/src/lib/finance-networth.ts",
    reexport: "../finance/networth/networth",
    symbols: ["computeNetWorthBreakdown", "snapshotNetWorth", "snapshotNetWorthForAllUsers", "listNetWorthHistory", "syncGoalProgress"],
    consumers: [
      { file: "artifacts/api-server/src/finance/application/networth.ts", specifier: "../networth/networth" }, // WP-8: routes go through the application entry point
      { file: "artifacts/api-server/src/finance/jobs/networth.ts", specifier: "../networth/networth" }, // WP-7: moved from lib/finance-networth-cron.ts
      { file: "artifacts/api-server/src/finance/notifications/notify.ts", specifier: "../networth/networth" },
    ],
  },
  {
    name: "AI",
    owner: "artifacts/api-server/src/finance/ai/finance-ai.ts",
    legacy: "artifacts/api-server/src/lib/finance-ai.ts",
    reexport: "../finance/ai/finance-ai",
    symbols: ["parseQuickEntryText", "findDuplicateEntry", "detectAnomalies", "detectRecurringCandidates", "answerFinanceQuery", "extractReceiptFields", "parseBankSms", "ensureSmsWebhookToken", "rotateSmsWebhookToken"],
    consumers: [{ file: "artifacts/api-server/src/finance/application/ai.ts", specifier: "../ai/finance-ai" }], // WP-8: routes go through application/ai
  },
  {
    name: "notifications",
    owner: "artifacts/api-server/src/finance/notifications/notify.ts",
    legacy: "artifacts/api-server/src/lib/finance-notify.ts",
    reexport: "../finance/notifications/notify",
    symbols: ["notifyEntryCreated", "runFinanceDailyDigest"],
    consumers: [
      { file: "artifacts/api-server/src/finance/application/entries.ts", specifier: "../notifications/notify" }, // WP-5b: moved from routes/finance.ts
      { file: "artifacts/api-server/src/finance/jobs/digest.ts", specifier: "../notifications/notify" }, // WP-7: moved from lib/finance-digest-cron.ts
    ],
  },
  {
    name: "receipt tokens",
    owner: "artifacts/api-server/src/finance/receipts/receipt-tokens.ts",
    legacy: "artifacts/api-server/src/lib/finance-accounting.ts",
    reexport: "../finance/receipts/receipt-tokens",
    symbols: ["generateReceiptToken", "financeReceiptUrl", "ensureReceiptToken"],
    consumers: [
      // WP-2b: the route's receipt-link logic moved to application/receipts.ts, which is now the consumer.
      { file: "artifacts/api-server/src/finance/application/receipts.ts", specifier: "../receipts/receipt-tokens" },
      { file: "artifacts/api-server/src/finance/notifications/notify.ts", specifier: "../receipts/receipt-tokens" },
    ],
  },
  {
    name: "payment methods",
    owner: "artifacts/api-server/src/finance/payment-methods/payment-methods.ts",
    legacy: "artifacts/api-server/src/lib/finance-invoice.ts",
    reexport: "../finance/payment-methods/payment-methods",
    symbols: [
      "generatePaymentQrDataUrl",
      "listActivePaymentMethods",
      "listFinancePaymentMethods",
      "resetFinancePaymentMethodDefaults",
      "createFinancePaymentMethod",
      "updateFinancePaymentMethod",
      "deleteFinancePaymentMethod",
    ],
    consumers: [
      { file: "artifacts/api-server/src/finance/application/payment-methods.ts", specifier: "../payment-methods/payment-methods" }, // WP-8: routes go through the application entry point
    ],
  },
];
for (const contract of extractedOwnerContracts) {
  const ownerPath = path.join(root, contract.owner);
  const ownerSource = fs.existsSync(ownerPath) ? readSource(ownerPath) : "";
  const ownersBySymbol = Object.fromEntries(contract.symbols.map((symbol) => [
    symbol,
    allFinanceImplementationSources
      .filter((file) => new RegExp(`\\b(?:async\\s+)?function\\s+${symbol}\\b`).test(readSource(file)))
      .map(relative),
  ]));
  const wrongOwners = Object.entries(ownersBySymbol)
    .filter(([, owners]) => owners.length !== 1 || owners[0] !== contract.owner);
  if (!ownerSource || wrongOwners.length) {
    findings.push({
      check: "extracted-finance-single-owner",
      module: contract.name,
      expectedOwner: contract.owner,
      wrongOwners: Object.fromEntries(wrongOwners),
    });
  }

  const missingConsumers = contract.consumers.filter(({ file, specifier }) => {
    const consumerPath = path.join(root, file);
    return !fs.existsSync(consumerPath)
      || !importedSpecifiers(readSource(consumerPath)).includes(specifier);
  });
  if (missingConsumers.length) {
    findings.push({
      check: "extracted-finance-consumer-wiring",
      module: contract.name,
      expectedImport: contract.reexport,
      missingConsumers,
    });
  }
}

const reportUseCaseOwner = "artifacts/api-server/src/finance/application/reports.ts";
const reportUseCaseSymbols = [
  "getFinanceSummary",
  "getFinanceProjections",
  "getFinanceExportRows",
  "getFinanceAnalytics",
  "getFinanceInsights",
  "getCustomFinanceReport",
  "getTrialBalanceReport",
  "getBalanceSheetReport",
  "getIncomeStatementReport",
  "getCashFlowReport",
];
const reportUseCaseOwners = Object.fromEntries(reportUseCaseSymbols.map((symbol) => [
  symbol,
  allFinanceImplementationSources
    .filter((file) => new RegExp(`\\b(?:async\\s+)?function\\s+${symbol}\\b`).test(readSource(file)))
    .map(relative),
]));
const duplicateOrMissingReportUseCases = Object.entries(reportUseCaseOwners)
  .filter(([, owners]) => owners.length !== 1 || owners[0] !== reportUseCaseOwner);
if (!fs.existsSync(path.join(root, reportUseCaseOwner)) || duplicateOrMissingReportUseCases.length) {
  findings.push({
    check: "read-only-report-single-owner",
    expectedOwner: reportUseCaseOwner,
    wrongOwners: Object.fromEntries(duplicateOrMissingReportUseCases),
  });
}
const reportRoute = "artifacts/api-server/src/routes/finance.ts";
if (!importedSpecifiers(readSource(path.join(root, reportRoute))).includes("../finance/application/reports")) {
  findings.push({
    check: "read-only-report-route-wiring",
    expectedImport: "../finance/application/reports",
    route: reportRoute,
  });
}

// WP-2b: single declaration owner and route wiring for the books/accounts, receipts, AI and
// invoice-branding use cases, plus the report-schedule job and its legacy re-export shim.
// WP-3: the ledger core lives in finance/ledger/*. Each symbol has exactly one declaration, the
// legacy lib/finance-accounting.ts may only re-export them, and ledger modules never import the
// legacy path, routes or application code (dependencies point downward only).
const ledgerDir = "artifacts/api-server/src/finance/ledger/";
const wp3Owners = {
  [ledgerDir + "books.ts"]: ["listBooks", "resolveBookId"],
  [ledgerDir + "system-accounts.ts"]: ["SYSTEM_ACCOUNTS", "ensureSystemAccounts", "AccountType"],
  [ledgerDir + "journal.ts"]: ["REPAYABLE_KINDS", "postJournal", "postEntryJournal", "postEntryAdjustmentJournal", "postRepaymentJournal", "postLateFeeAccrualJournal", "deleteJournalForEntry", "deleteLedgerEntryCascade", "FinanceDbTransaction"],
  [ledgerDir + "repayments.ts"]: ["applyPrincipalRepayment", "applyPrincipalRepaymentTx", "recordRepayment", "payAmortizationInstallment", "RecordRepaymentInput", "RecordRepaymentResult", "PayInstallmentResult"],
  [ledgerDir + "balances.ts"]: ["computeAccountBalances", "AccountBalanceRow"],
};
// A declaration, not an import specifier like `import { type X }`: types need `=` or `<` after the name.
const declaresSymbol = (file, symbol) => new RegExp(`\\b(?:(?:async\\s+)?function|const|interface)\\s+${symbol}\\b|\\btype\\s+${symbol}\\s*[=<]`).test(readSource(file));
for (const [owner, symbols] of Object.entries(wp3Owners)) {
  const wrong = {};
  for (const symbol of symbols) {
    const owners = allFinanceImplementationSources.filter((file) => declaresSymbol(file, symbol)).map(relative);
    if (owners.length !== 1 || owners[0] !== owner) wrong[symbol] = owners;
  }
  if (!fs.existsSync(path.join(root, owner)) || Object.keys(wrong).length) {
    findings.push({ check: "wp3-single-owner", expectedOwner: owner, wrongOwners: wrong });
  }
}
for (const file of allFinanceImplementationSources.filter((f) => relative(f).startsWith(ledgerDir))) {
  const forbidden = importedSpecifiers(readSource(file)).filter((specifier) =>
    /(^|\/)lib\//.test(specifier) || /(^|\/)routes\//.test(specifier) || /\/application\//.test(specifier) || /finance-accounting/.test(specifier));
  if (forbidden.length) findings.push({ check: "wp3-ledger-forbidden-imports", file: relative(file), forbidden });
}

// WP-4: schedules. Pure math lives in finance/domain/schedules.ts, persistence in finance/schedules/*,
// use cases in finance/application/assets.ts; lib/finance-accounting.ts is a pure re-export shim.
const wp4Owners = {
  "artifacts/api-server/src/finance/domain/schedules.ts": ["buildAmortizationRows", "buildDepreciationRows"],
  "artifacts/api-server/src/finance/schedules/amortization.ts": ["fmtAmortRow", "generateAmortizationSchedule", "listAmortizationForEntry", "AmortizationRowShape"],
  "artifacts/api-server/src/finance/schedules/depreciation.ts": ["fmtDeprecRow", "generateDepreciationSchedule", "listDepreciationForAsset", "postDepreciationJournal", "DepreciationRowShape"],
  "artifacts/api-server/src/finance/application/assets.ts": ["listAssets", "createAsset", "updateAsset", "deleteAsset", "listAmortization", "generateAmortization", "listDepreciation", "generateDepreciation", "postDepreciationPeriod"],
};
for (const [owner, symbols] of Object.entries(wp4Owners)) {
  const wrong = {};
  for (const symbol of symbols) {
    const owners = allFinanceImplementationSources.filter((file) => declaresSymbol(file, symbol)).map(relative);
    if (owners.length !== 1 || owners[0] !== owner) wrong[symbol] = owners;
  }
  if (!fs.existsSync(path.join(root, owner)) || Object.keys(wrong).length) {
    findings.push({ check: "wp4-single-owner", expectedOwner: owner, wrongOwners: wrong });
  }
}
{
  const pureSource = readSource(path.join(root, "artifacts/api-server/src/finance/domain/schedules.ts"));
  const pureImports = importedSpecifiers(pureSource);
  if (pureImports.length !== 1 || pureImports[0] !== "./recurrence-dates" || /\bnew Date\(\)|Date\.now\(|Math\.random\(/.test(pureSource)) {
    findings.push({ check: "wp4-domain-schedules-not-pure", imports: pureImports });
  }
  const goldenPath = path.join(root, "artifacts/api-server/src/finance/domain/schedules.golden.json");
  if (!fs.existsSync(goldenPath)) findings.push({ check: "wp4-golden-fixture-missing" });
  const wp4Wiring = {
    "artifacts/api-server/src/routes/finance.ts": ["../finance/application/assets"],
    "artifacts/api-server/src/finance/application/assets.ts": ["../schedules/amortization", "../schedules/depreciation"],
    "artifacts/api-server/src/finance/schedules/amortization.ts": ["../domain/schedules"],
    "artifacts/api-server/src/finance/schedules/depreciation.ts": ["../domain/schedules", "../ledger/journal"],
  };
  for (const [file, expected] of Object.entries(wp4Wiring)) {
    const imported = importedSpecifiers(readSource(path.join(root, file)));
    const missing = expected.filter((specifier) => !imported.includes(specifier));
    if (missing.length) findings.push({ check: "wp4-wiring", file, missing });
  }
}

// WP-5a: recurring rules and manual journal use cases, plus the recurring sweep job (moved from
// lib/finance-recurring-cron.ts, which is now a re-export shim). jobs/recurring.ts still imports
// lib/finance-invoice (createAndSendRuleInvoice) until WP-6 moves invoices.
const wp5aOwners = {
  "artifacts/api-server/src/finance/application/recurring.ts": ["listRecurringRules", "createRecurringRule", "updateRecurringRule", "deleteRecurringRule", "runRecurringNow"],
  "artifacts/api-server/src/finance/application/journal.ts": ["listJournal", "getJournalEntry", "createManualJournal", "deleteManualJournal"],
  "artifacts/api-server/src/finance/jobs/recurring.ts": ["runFinanceRecurringSweep", "startFinanceRecurringCron"],
};
for (const [owner, symbols] of Object.entries(wp5aOwners)) {
  const wrong = {};
  for (const symbol of symbols) {
    const owners = allFinanceImplementationSources.filter((file) => declaresSymbol(file, symbol)).map(relative);
    if (owners.length !== 1 || owners[0] !== owner) wrong[symbol] = owners;
  }
  if (!fs.existsSync(path.join(root, owner)) || Object.keys(wrong).length) {
    findings.push({ check: "wp5a-single-owner", expectedOwner: owner, wrongOwners: wrong });
  }
}
const wp5aWiring = {
  "artifacts/api-server/src/routes/finance.ts": ["../finance/application/recurring", "../finance/application/journal"],
  "artifacts/api-server/src/finance/application/recurring.ts": ["../jobs/recurring"],
  "artifacts/api-server/src/finance/application/journal.ts": ["../ledger/journal", "../ledger/books"],
  "artifacts/api-server/src/finance/jobs/recurring.ts": ["../ledger/journal", "../ledger/books", "./due-rules"],
};
for (const [file, expected] of Object.entries(wp5aWiring)) {
  const imported = importedSpecifiers(readSource(path.join(root, file)));
  const missing = expected.filter((specifier) => !imported.includes(specifier));
  if (missing.length) findings.push({ check: "wp5a-wiring", file, missing });
}
// WP-5b: ledger entry use cases (CRUD, repayments, attachments, invoice lines, CSV import).
const wp5bOwners = {
  "artifacts/api-server/src/finance/application/entries.ts": ["assertEntryOwnership", "listEntries", "createEntry", "updateEntry", "deleteEntry", "listRepayments", "addRepayment", "listEntryAttachments", "uploadEntryAttachment", "getEntryAttachment", "deleteEntryAttachment", "listInvoiceLines", "replaceInvoiceLines", "importEntriesCsv"],
};
for (const [owner, symbols] of Object.entries(wp5bOwners)) {
  const wrong = {};
  for (const symbol of symbols) {
    const owners = allFinanceImplementationSources.filter((file) => declaresSymbol(file, symbol)).map(relative);
    if (owners.length !== 1 || owners[0] !== owner) wrong[symbol] = owners;
  }
  if (!fs.existsSync(path.join(root, owner)) || Object.keys(wrong).length) {
    findings.push({ check: "wp5b-single-owner", expectedOwner: owner, wrongOwners: wrong });
  }
}
{
  const wp5bWiring = {
    "artifacts/api-server/src/routes/finance.ts": ["../finance/application/entries"],
    "artifacts/api-server/src/finance/application/entries.ts": ["../ledger/journal", "../ledger/repayments", "../ledger/books", "../notifications/notify"],
  };
  for (const [file, expected] of Object.entries(wp5bWiring)) {
    const imported = importedSpecifiers(readSource(path.join(root, file)));
    const missing = expected.filter((specifier) => !imported.includes(specifier));
    if (missing.length) findings.push({ check: "wp5b-wiring", file, missing });
  }
}

// WP-6a: invoices. Use cases in application/invoices.ts; helpers in finance/invoices/*; the legacy
// lib/finance-invoice.ts and lib/invoice-pdf.ts are pure re-export shims. Payment agreements (6 handlers) are WP-6b below.
const wp6aOwners = {
  "artifacts/api-server/src/finance/application/invoices.ts": ["parseLineItemsFromBody", "brandingFromUser", "findInvoiceOwnerId", "listInvoices", "createInvoice", "updateInvoiceLineItems", "getInvoiceDetail", "streamCreditorInvoicePdf", "streamPublicInvoicePdf", "sendInvoice", "cancelInvoice", "reopenInvoice", "getPublicInvoiceView", "submitInvoicePayment"],
  "artifacts/api-server/src/finance/invoices/links.ts": ["generateInvoiceToken", "generateAgreementToken", "financeInvoiceUrl", "financePaymentAgreementUrl", "generateInvoicePayLinkQrDataUrl"],
  "artifacts/api-server/src/finance/invoices/events.ts": ["logInvoiceEvent", "getClientIpLocal"],
  "artifacts/api-server/src/finance/invoices/store.ts": ["getInvoiceByToken", "getInvoiceLineItems", "replaceInvoiceLineItemsInTx", "replaceInvoiceLineItems", "getCreditorProfile"],
  "artifacts/api-server/src/finance/invoices/rule-invoice.ts": ["createAndSendRuleInvoice"],
  "artifacts/api-server/src/finance/invoices/pdf.ts": ["streamInvoicePdf"],
};
for (const [owner, symbols] of Object.entries(wp6aOwners)) {
  const wrong = {};
  for (const symbol of symbols) {
    const owners = allFinanceImplementationSources.filter((file) => declaresSymbol(file, symbol)).map(relative);
    if (owners.length !== 1 || owners[0] !== owner) wrong[symbol] = owners;
  }
  if (!fs.existsSync(path.join(root, owner)) || Object.keys(wrong).length) {
    findings.push({ check: "wp6a-single-owner", expectedOwner: owner, wrongOwners: wrong });
  }
}
{
  const wp6aWiring = {
    "artifacts/api-server/src/routes/finance-invoices.ts": ["../finance/application/invoices"],
    "artifacts/api-server/src/finance/application/invoices.ts": ["../invoices/links", "../invoices/events", "../invoices/store", "../invoices/pdf", "../ledger/journal", "../ledger/books"],
    "artifacts/api-server/src/finance/jobs/recurring.ts": ["../invoices/rule-invoice"],
    "artifacts/api-server/src/finance/jobs/invoice-reminder.ts": ["../invoices/links", "../invoices/events"], // WP-7: moved from lib/finance-invoice-reminder-cron.ts
  };
  for (const [file, expected] of Object.entries(wp6aWiring)) {
    const imported = importedSpecifiers(readSource(path.join(root, file)));
    const missing = expected.filter((specifier) => !imported.includes(specifier));
    if (missing.length) findings.push({ check: "wp6a-wiring", file, missing });
  }
}

// WP-6b: payment agreements. The six handlers' logic lives in application/payment-agreements.ts; the route is an adapter.
const wp6bOwners = {
  "artifacts/api-server/src/finance/application/payment-agreements.ts": ["findAgreementByToken", "findAgreementInvoiceOwner", "getPublicAgreementView", "createPasskeyOptions", "confirmAgreementWithPasskey", "streamAgreementEvidencePdf", "verifyPaymentAgreement", "disputePaymentAgreement"],
};
for (const [owner, symbols] of Object.entries(wp6bOwners)) {
  const wrong = {};
  for (const symbol of symbols) {
    const owners = allFinanceImplementationSources.filter((file) => declaresSymbol(file, symbol)).map(relative);
    if (owners.length !== 1 || owners[0] !== owner) wrong[symbol] = owners;
  }
  if (!fs.existsSync(path.join(root, owner)) || Object.keys(wrong).length) {
    findings.push({ check: "wp6b-single-owner", expectedOwner: owner, wrongOwners: wrong });
  }
}
{
  const wp6bWiring = {
    "artifacts/api-server/src/routes/finance-invoices.ts": ["../finance/application/payment-agreements"],
    "artifacts/api-server/src/finance/application/payment-agreements.ts": ["../invoices/events", "../ledger/repayments", "../ledger/journal"],
  };
  for (const [file, expected] of Object.entries(wp6bWiring)) {
    const imported = importedSpecifiers(readSource(path.join(root, file)));
    const missing = expected.filter((specifier) => !imported.includes(specifier));
    if (missing.length) findings.push({ check: "wp6b-wiring", file, missing });
  }
  // The route must not import the ledger, the mailers or the receipt PDF theme any more: those belong to the use cases.
  const routeImports = importedSpecifiers(readSource(path.join(root, "artifacts/api-server/src/routes/finance-invoices.ts")));
  const leaked = routeImports.filter((spec) => /ledger\/(journal|repayments)$|\/lib\/(email|telegram|receipt-theme)$|^\.\.\/lib\/(email|telegram|receipt-theme)$/.test(spec));
  if (leaked.length) findings.push({ check: "wp6b-route-imports", file: "artifacts/api-server/src/routes/finance-invoices.ts", leaked });
}

// WP-8: the compatibility shims are gone. No lib/finance-*.ts (apart from the DB-test runner and its test) and no
// lib/invoice-pdf.ts remain, nothing imports those paths (tests included), and the two Finance route files import
// Finance code only through finance/application/*.
const legacyNames = /^(finance-(accounting|ai|digest-cron|invoice|invoice-reminder-cron|late-fee-cron|networth|networth-cron|notify|recurring-cron|reminder-cron|report-schedule-cron|wallet-bridge)|invoice-pdf)$/;
// A specifier names a removed shim only when it points into lib/ (finance/ai/finance-ai is a real owner).
const isLegacySpec = (spec, importer) => {
  const m = spec.match(/^(?:.*\/lib\/|\.\/)([^/]+)$/);
  if (!m || !legacyNames.test(m[1])) return false;
  return spec.includes("/lib/") || importer.startsWith(`${path.join(serverRoot, "lib")}${path.sep}`);
};
{
  const libDir = path.join(serverRoot, "lib");
  const leftover = fs.readdirSync(libDir).filter((name) =>
    (/^finance-.+\.(ts|mjs)$/.test(name) && !/^finance-accounting\.db(-runner\.mjs|\.test\.ts)$/.test(name)) || name === "invoice-pdf.ts");
  if (leftover.length) findings.push({ check: "wp8-shims-removed", files: leftover });
  const importers = walk(serverRoot).filter(isSource)
    .filter((file) => importedSpecifiers(readSource(file)).some((spec) => isLegacySpec(spec, file)))
    .map(relative);
  if (importers.length) findings.push({ check: "wp8-no-legacy-importers", files: importers });
  for (const route of ["artifacts/api-server/src/routes/finance.ts", "artifacts/api-server/src/routes/finance-invoices.ts"]) {
    const offenders = importedSpecifiers(readSource(path.join(root, route)))
      .filter((spec) => /(^|\/)finance\//.test(spec) && !/^\.\.\/finance\/application\//.test(spec));
    if (offenders.length) findings.push({ check: "wp8-routes-import-application-only", file: route, offenders });
  }
}

// WP-7: fees, jobs and the wallet bridge. The six legacy lib files are re-export shims; the logic has one owner each.
const wp7Owners = {
  "artifacts/api-server/src/finance/domain/late-fees.ts": ["lateFeeAccrual", "lateFeeGraceEnd", "lateFeeAccrualStart", "originalPrincipal", "lateFeeUsesPrincipal"],
  "artifacts/api-server/src/finance/fees/late-fees.ts": ["runFinanceLateFeeSweep"],
  "artifacts/api-server/src/finance/jobs/late-fee.ts": ["startFinanceLateFeeCron"],
  "artifacts/api-server/src/finance/jobs/reminder.ts": ["runFinanceReminderSweep", "startFinanceReminderCron"],
  "artifacts/api-server/src/finance/jobs/invoice-reminder.ts": ["runFinanceInvoiceReminderSweep", "startFinanceInvoiceReminderCron"],
  "artifacts/api-server/src/finance/jobs/digest.ts": ["startFinanceDigestCron"],
  "artifacts/api-server/src/finance/jobs/networth.ts": ["startFinanceNetWorthCron"],
  "artifacts/api-server/src/finance/integrations/wallet-bridge.ts": ["postDepositToFinance", "postWithdrawalToFinance"],
  "artifacts/api-server/src/finance/ledger/journal.ts": ["postEntryJournalInTx", "postLateFeeAccrualJournalInTx"],
};
for (const [owner, symbols] of Object.entries(wp7Owners)) {
  const wrong = {};
  for (const symbol of symbols) {
    const owners = allFinanceImplementationSources.filter((file) => declaresSymbol(file, symbol)).map(relative);
    if (owners.length !== 1 || owners[0] !== owner) wrong[symbol] = owners;
  }
  if (!fs.existsSync(path.join(root, owner)) || Object.keys(wrong).length) {
    findings.push({ check: "wp7-single-owner", expectedOwner: owner, wrongOwners: wrong });
  }
}
{
  const wp7Wiring = {
    "artifacts/api-server/src/index.ts": ["./finance/jobs/reminder", "./finance/jobs/networth", "./finance/jobs/digest", "./finance/jobs/invoice-reminder", "./finance/jobs/late-fee"],
    "artifacts/api-server/src/services/deposit-watcher.ts": ["../finance/integrations/wallet-bridge"],
    "artifacts/api-server/src/routes/wallets.ts": ["../finance/integrations/wallet-bridge"],
    "artifacts/api-server/src/finance/fees/late-fees.ts": ["../domain/late-fees", "../ledger/journal"],
    "artifacts/api-server/src/finance/jobs/late-fee.ts": ["../fees/late-fees"],
    "artifacts/api-server/src/finance/integrations/wallet-bridge.ts": ["../ledger/journal", "../ledger/books"],
  };
  for (const [file, expected] of Object.entries(wp7Wiring)) {
    const imported = importedSpecifiers(readSource(path.join(root, file)));
    const missing = expected.filter((specifier) => !imported.includes(specifier));
    if (missing.length) findings.push({ check: "wp7-wiring", file, missing });
  }
  // The new owners must not reach into routes or the legacy lib shims; the notification goes through lib/create-notification.
  const wp7Files = Object.keys(wp7Owners).filter((file) => !file.endsWith("domain/late-fees.ts") && !file.endsWith("ledger/journal.ts"));
  const wp7Leaks = [];
  for (const file of wp7Files) {
    for (const spec of importedSpecifiers(readSource(path.join(root, file)))) {
      if (/\/routes\//.test(spec) || isLegacySpec(spec, path.join(root, file))) wp7Leaks.push({ file, spec });
    }
  }
  if (wp7Leaks.length) findings.push({ check: "wp7-owner-imports", leaks: wp7Leaks });
}

const wp2bOwners = {
  "artifacts/api-server/src/finance/application/books-accounts.ts": ["listUserBooks", "createBook", "updateBook", "setDefaultBook", "deleteBook", "listAccounts", "createAccount", "updateAccount", "deleteAccount"],
  "artifacts/api-server/src/finance/application/receipts.ts": ["mintEntryReceiptLink", "revokeEntryReceiptLink", "findByReceiptToken", "fmtPublicReceipt", "renderReceiptPdf"],
  "artifacts/api-server/src/finance/application/ai.ts": ["previewQuickEntries", "commitQuickEntries", "scanReceipt", "getSmsWebhookInfo", "rotateSmsWebhookInfo", "ingestSmsWebhook"],
  "artifacts/api-server/src/finance/application/invoice-branding.ts": ["getInvoiceBranding", "updateInvoiceBranding"],
  "artifacts/api-server/src/finance/jobs/report-schedule.ts": ["runFinanceReportSchedules", "startFinanceReportScheduleCron"],
};
for (const [owner, symbols] of Object.entries(wp2bOwners)) {
  const wrong = {};
  for (const symbol of symbols) {
    const owners = allFinanceImplementationSources
      .filter((file) => new RegExp(`\\b(?:async\\s+)?function\\s+${symbol}\\b`).test(readSource(file)))
      .map(relative);
    if (owners.length !== 1 || owners[0] !== owner) wrong[symbol] = owners;
  }
  if (!fs.existsSync(path.join(root, owner)) || Object.keys(wrong).length) {
    findings.push({ check: "wp2b-single-owner", expectedOwner: owner, wrongOwners: wrong });
  }
}
const wp2bRouteWiring = {
  "artifacts/api-server/src/routes/finance.ts": ["../finance/application/books-accounts", "../finance/application/receipts", "../finance/application/ai"],
  "artifacts/api-server/src/routes/finance-invoices.ts": ["../finance/application/invoice-branding"],
  "artifacts/api-server/src/index.ts": ["./finance/jobs/report-schedule"],
};
for (const [file, expected] of Object.entries(wp2bRouteWiring)) {
  const imported = importedSpecifiers(readSource(path.join(root, file)));
  const missing = expected.filter((specifier) => !imported.includes(specifier));
  if (missing.length) findings.push({ check: "wp2b-route-wiring", file, missing });
}
const paymentMethodOwner = "artifacts/api-server/src/finance/payment-methods/payment-methods.ts";
const paymentMethodLabelOwners = allFinanceImplementationSources
  .filter((file) => /\bexport\s+const\s+PAYMENT_METHOD_LABELS\b/.test(readSource(file)))
  .map(relative);
if (paymentMethodLabelOwners.length !== 1 || paymentMethodLabelOwners[0] !== paymentMethodOwner) {
  findings.push({
    check: "payment-method-label-single-owner",
    expectedOwner: paymentMethodOwner,
    actualOwners: paymentMethodLabelOwners,
  });
}
const allowedRouteEdges = new Set([
  // WP-7/R-09: no Finance owner imports routes/* any more; notifications load lib/create-notification.
]);
const observedRouteEdges = [];
const unapprovedRouteEdges = [];
for (const file of financeSources) {
  for (const specifier of importedSpecifiers(readSource(file))) {
    if (!specifier.includes("/routes/")) continue;
    const edge = `${relative(file)} -> ${specifier}`;
    observedRouteEdges.push(edge);
    if (!allowedRouteEdges.has(edge)) unapprovedRouteEdges.push(edge);
  }
}
if (unapprovedRouteEdges.length) {
  findings.push({ check: "finance-library-route-imports", unapprovedEdges: unapprovedRouteEdges });
}

const cycles = stronglyConnectedComponents(graph)
  .filter((component) => (component.length > 1
    || (graph.get(component[0]) ?? []).includes(component[0]))
    && component.some((file) => financeSourceSet.has(file)))
  .map((component) => component.map(relative).sort());
for (const cycle of cycles) {
  findings.push({ check: "finance-import-cycle", files: cycle });
}

const ciWorkflow = fs.existsSync(ciWorkflowPath) ? readSource(ciWorkflowPath) : "";
const ciCommand = "pnpm validate:finance-boundaries";
const ciWired = new RegExp(`^\\s*-\\s*run:\\s*${ciCommand.replaceAll(":", "\\:")}\\s*$`, "m").test(ciWorkflow);
if (!ciWired) {
  findings.push({ check: "finance-boundary-ci-wiring", expected: ciCommand, workflow: relative(ciWorkflowPath) });
}

const scannedFiles = [...new Set([
  ...financeSourcesIncludingService,
  ...walk(domainRoot).filter(isSource),
  validatorPath,
  ciWorkflowPath,
  path.join(root, "docs/antas/finance/finance-boundaries.md"),
  path.join(root, "package.json"),
  path.join(root, "artifacts/api-server/package.json"),
])]
  .filter(fs.existsSync)
  .sort();
const gitSha = (() => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "UNAVAILABLE";
  }
})();
const report = {
  schemaVersion: 1,
  phase: "FIN-01",
  check: "Finance dependency and ownership scan",
  generatedAt: new Date().toISOString(),
  status: findings.length ? "BLOCKED" : "PASS",
  sourceRevision: {
    baseCommit: gitSha,
    worktreeState: "See git status; this report includes source hashes to bind its result to the working tree.",
  },
  scannedFinanceSourceCount: financeSourcesIncludingService.length,
  scannedApiFinanceSourceCount: financeSources.length,
  scannedExtractedServiceSourceCount: financeServiceSources.length,
  ciWiring: { workflow: relative(ciWorkflowPath), command: ciCommand, present: ciWired },
  invoiceCalculationOwners: declarationOwners,
  invoiceFormatOwners: formatDeclarationOwners,
  recurrenceDateOwners: dateDeclarationOwners,
  recurrenceDateConsumerWiring: dateConsumerWiring,
  approvedLegacyRouteEdges: [...allowedRouteEdges].sort(),
  observedRouteEdges: observedRouteEdges.sort(),
  financeImportCycles: cycles,
  sourceSha256: Object.fromEntries(scannedFiles.map((file) => [
    relative(file),
    crypto.createHash("sha256").update(readSource(file)).digest("hex"),
  ])),
  findings,
};

fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
fs.writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Finance boundary scan: ${report.status} (${financeSources.length} Finance sources, ${findings.length} finding(s))`);
console.log(`Evidence: ${relative(evidencePath)}`);
if (findings.length) {
  console.error(findings.map((finding) => `${finding.check}: ${JSON.stringify(finding)}`).join("\n"));
  process.exitCode = 1;
}
