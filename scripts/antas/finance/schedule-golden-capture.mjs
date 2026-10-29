#!/usr/bin/env node
// Captures GOLDEN schedule rows from a module that still contains the original, DB-coupled
// generateAmortizationSchedule / generateDepreciationSchedule. The DB and drizzle-orm are stubbed
// (rows passed to insert().values() are recorded, nothing is persisted), so the output is exactly
// what the baseline code would have written. Run it against the BASELINE revision, never against
// the refactored code, then commit the JSON as the fixture the pure math must reproduce.
//
//   node --experimental-strip-types scripts/antas/finance/schedule-golden-capture.mjs <module.ts> <out.json>
// The module must sit inside the api-server tree (its relative imports are resolved from its location).
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

const [, , modulePath, outPath] = process.argv;
if (!modulePath || !outPath) { console.error("usage: schedule-golden-capture.mjs <module.ts> <out.json>"); process.exit(2); }
const abs = path.resolve(modulePath);

const hooks = `
export async function resolve(specifier, ctx, next) {
  if (specifier === "@workspace/db") return { url: "data:text/javascript," + encodeURIComponent(${JSON.stringify(`
    export const financeAmortizationTable = { __t: "amort", ledgerEntryId: "ledgerEntryId", id: "id" };
    export const financeDepreciationTable = { __t: "deprec", assetId: "assetId", id: "id" };
    // Other tables the ledger modules import; never touched by the schedule generators.
    export const financeAccountsTable = {}; export const financeBooksTable = {};
    export const financeJournalEntriesTable = {}; export const financeJournalLinesTable = {};
    export const financeLedgerEntriesTable = {}; export const financeRepaymentsTable = {};
    export const db = {
      delete() { return { where: async () => [] }; },
      insert(t) { return { values(rows) { return { returning: async () => { globalThis.__captured.push({ table: t.__t, rows }); return rows.map((r, i) => ({ ...r, id: i + 1, paidAt: null, postedAt: null })); } }; } }; },
      select() { throw new Error("select not stubbed"); },
      transaction() { throw new Error("transaction not stubbed"); },
    };`)}), shortCircuit: true };
  if (specifier === "drizzle-orm") return { url: "data:text/javascript," + encodeURIComponent("export const eq=()=>({}); export const and=()=>({}); export const ne=()=>({}); export const lte=()=>({}); export const gte=()=>({}); export const inArray=()=>({}); export const sql=()=>({});"), shortCircuit: true };
  if (/^\\.{1,2}\\//.test(specifier) && !/\\.[a-z]+$/.test(specifier)) {
    try { return await next(specifier + ".ts", ctx); } catch {}
  }
  return next(specifier, ctx);
}`;
register("data:text/javascript," + encodeURIComponent(hooks), import.meta.url);
globalThis.__captured = [];

const mod = await import(pathToFileURL(abs).href);
const D = (s) => new Date(s);
const run = async (fn, input) => { globalThis.__captured = []; const returned = await fn(input.arg, input.months); return { returned: returned.length, captured: globalThis.__captured }; };

const cases = { amortization: [], depreciation: [] };
const principals = [0, 0.01, 1000, 1234.56, 99999.99, 1000000];
const rates = [0, 5, 7.75, 12.5, 36];
const terms = [1, 2, 3, 7, 12, 24, 36, 60];
const starts = ["2024-01-31T00:00:00.000Z", "2024-02-29T00:00:00.000Z", "2023-12-15T10:30:00.000Z", "2024-03-31T23:59:59.000Z"];
let n = 0;
for (const principal of principals) for (const rate of rates) for (const term of terms) {
  const start = starts[n++ % starts.length];
  const entry = { id: 7, userId: 3, amount: principal, interestRate: rate, occurredDate: D(start), dueDate: D("2030-01-01T00:00:00.000Z") };
  const r = await run((e, m) => mod.generateAmortizationSchedule(e, m), { arg: entry, months: term });
  cases.amortization.push({ input: { userId: 3, entryId: 7, principal, annualRate: rate, termMonths: term, startDate: start }, rows: r.captured[0].rows });
}
// fallback chain: occurredDate missing -> dueDate used
{
  const entry = { id: 8, userId: 4, amount: 5000, interestRate: 9, occurredDate: null, dueDate: D("2024-05-31T00:00:00.000Z") };
  const r = await run((e, m) => mod.generateAmortizationSchedule(e, m), { arg: entry, months: 6 });
  cases.amortization.push({ input: { userId: 4, entryId: 8, principal: 5000, annualRate: 9, termMonths: 6, startDate: "2024-05-31T00:00:00.000Z" }, rows: r.captured[0].rows });
}
// amount/interestRate null -> treated as 0
{
  const entry = { id: 9, userId: 5, amount: null, interestRate: null, occurredDate: D("2024-01-10T00:00:00.000Z"), dueDate: null };
  const r = await run((e, m) => mod.generateAmortizationSchedule(e, m), { arg: entry, months: 3 });
  cases.amortization.push({ input: { userId: 5, entryId: 9, principal: 0, annualRate: 0, termMonths: 3, startDate: "2024-01-10T00:00:00.000Z" }, rows: r.captured[0].rows });
}

const costs = [0, 1, 1000, 12345.67, 250000];
const salvages = [0, 100, 5000, 300000];
const months = [1, 2, 12, 36, 60];
const methods = ["straight_line", "declining_balance"];
n = 0;
for (const method of methods) for (const cost of costs) for (const salvage of salvages) for (const m of months) {
  const start = starts[n++ % starts.length];
  const asset = { id: 11, userId: 6, depreciationMethod: method, usefulLifeMonths: m, purchasedValue: cost, totalValue: 999, salvageValue: salvage, depreciationStartDate: D(start), purchaseDate: D("2020-01-01T00:00:00.000Z") };
  const r = await run((a) => mod.generateDepreciationSchedule(a), { arg: asset });
  cases.depreciation.push({ input: { userId: 6, assetId: 11, method, cost, salvage, months: m, startDate: start }, rows: r.captured[0].rows });
}
// cost fallback to totalValue when purchasedValue is null; salvage null -> 0; start from purchaseDate
{
  const asset = { id: 12, userId: 6, depreciationMethod: "straight_line", usefulLifeMonths: 10, purchasedValue: null, totalValue: 5000, salvageValue: null, depreciationStartDate: null, purchaseDate: D("2022-08-31T00:00:00.000Z") };
  const r = await run((a) => mod.generateDepreciationSchedule(a), { arg: asset });
  cases.depreciation.push({ input: { userId: 6, assetId: 12, method: "straight_line", cost: 5000, salvage: 0, months: 10, startDate: "2022-08-31T00:00:00.000Z" }, rows: r.captured[0].rows });
}
// guards: no method / non-positive life -> no rows, no insert
const guard = [];
for (const a of [{ id: 13, userId: 6, depreciationMethod: null, usefulLifeMonths: 12 }, { id: 14, userId: 6, depreciationMethod: "straight_line", usefulLifeMonths: 0 }, { id: 15, userId: 6, depreciationMethod: "straight_line", usefulLifeMonths: -3 }]) {
  globalThis.__captured = [];
  const out = await mod.generateDepreciationSchedule(a);
  guard.push({ usefulLifeMonths: a.usefulLifeMonths, method: a.depreciationMethod, returned: out.length, inserts: globalThis.__captured.length });
}
cases.depreciationGuards = guard;

// Compact fixture: per-case digest of the canonicalised rows (sorted keys, dates as ISO via JSON) plus a
// few full samples. The pure-math test recomputes the same digest from the extracted functions.
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) && !(x instanceof Date))
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x);
const digest = (rows) => crypto.createHash("sha256").update(canon(rows)).digest("hex");
const compact = (list) => list.map((c, i) => ({ input: c.input, rowCount: c.rows.length, sha256: digest(c.rows), ...(i % 40 === 0 ? { sample: c.rows } : {}) }));
cases.amortization = compact(cases.amortization);
cases.depreciation = compact(cases.depreciation);

const out = {
  schemaVersion: 1,
  capturedFrom: { file: path.basename(abs), sha256: crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex") },
  counts: { amortization: cases.amortization.length, depreciation: cases.depreciation.length },
  ...cases,
};
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(JSON.stringify({ out: outPath, ...out.counts, guards: guard.length, sha256: out.capturedFrom.sha256 }));
