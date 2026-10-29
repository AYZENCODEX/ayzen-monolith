// Control-flow simulation of postDepreciationPeriod with a scripted, stubbed DB (F10a/F10b). Run from artifacts/api-server/src:
//   node --experimental-strip-types --no-warnings <path-to>/depreciation-post-flow-sim.mjs   (copy it into src/ first; it imports finance/application/assets.ts by relative path)
// It proves ordering and rollback/outcome mapping only; atomicity itself is proven by wp4-use-cases.db.test.ts (unrun here).
import { register } from "node:module";
import { pathToFileURL } from "node:url";
const stub = `
  const T = (n) => new Proxy({ __t: n }, { get: (o, k) => k in o ? o[k] : k });
  export const financeAssetsTable = T("assets"), financeAssetOwnersTable = T("owners"), financeDepreciationTable = T("deprec"), financeLedgerEntriesTable = T("ledger"),
    financeAmortizationTable = T("amort"), financeAccountsTable = {}, financeBooksTable = {}, financeJournalEntriesTable = {}, financeJournalLinesTable = {}, financeRepaymentsTable = {};
  const chain = (result, log, tag) => { const c = { from: () => c, where: () => c, orderBy: () => c, limit: () => c, set: (v) => { log.push([tag, "set", v]); return c; }, returning: async () => result(), then: (res, rej) => Promise.resolve(result()).then(res, rej) }; return c; };
  export const db = {
    select: () => chain(() => globalThis.__selects.shift(), globalThis.__log, "select"),
    update: (t) => chain(() => globalThis.__updates.shift() ?? [], globalThis.__log, "db.update:" + t.__t),
    transaction: async (fn) => {
      const log = globalThis.__log; log.push(["tx", "begin"]);
      const tx = { select: () => chain(() => globalThis.__txSelects.shift(), log, "tx.select"), update: (t) => chain(() => globalThis.__txUpdates.shift() ?? [], log, "tx.update:" + t.__t) };
      try { const r = await fn(tx); log.push(["tx", "commit"]); return r; } catch (e) { log.push(["tx", "rollback"]); throw e; }
    },
  };`;
const hooks = `export async function resolve(s,c,n){
 if(s==="@workspace/db") return {url:"data:text/javascript,"+encodeURIComponent(${JSON.stringify(stub)}),shortCircuit:true};
 if(s==="drizzle-orm") return {url:"data:text/javascript,"+encodeURIComponent("export const eq=()=>1,and=()=>1,ne=()=>1,desc=()=>1,sql=()=>1,inArray=()=>1,lte=()=>1,gte=()=>1;"),shortCircuit:true};
 if(/^\\.{1,2}\\//.test(s)&&!/\\.[a-z]+$/.test(s)){try{return await n(s+".ts",c);}catch{}} return n(s,c);}`;
register("data:text/javascript," + encodeURIComponent(hooks), import.meta.url);
const { postDepreciationPeriod } = await import(pathToFileURL("finance/application/assets.ts").href);
const row = { id: 5, userId: 1, assetId: 9, status: "upcoming", periodDate: new Date("2024-02-15"), depreciationAmount: 100, bookValue: 1100 };
const asset = { id: 9, userId: 1, name: "Rig" };
const setup = (o = {}) => { globalThis.__log = []; globalThis.__selects = [[row], [asset]]; globalThis.__txSelects = o.txSelects ?? []; globalThis.__txUpdates = o.txUpdates ?? [[{ ...row, status: "posted" }]]; globalThis.__updates = []; };
const ev = (l) => l.filter(([a]) => a !== "select").map((x) => x.slice(0, 2).join(":") + (x[2]?.status ? `(${x[2].status})` : "")).join(" > ");
const results = [];
const check = (name, ok, extra) => { results.push({ name, ok, extra }); };

// 1. success: claim -> journal -> asset update -> commit, journal runs BEFORE the asset update
setup(); let order = [];
let r = await postDepreciationPeriod(1, 5, { postJournalInTx: async () => { order.push("journal"); globalThis.__log.push(["journal", "step"]); return true; } });
check("success commits", r.status === "ok" && r.row.status === "posted" && ev(globalThis.__log).endsWith("tx:commit"), ev(globalThis.__log));
const names = globalThis.__log.map((x) => x[0]); 
check("journal step runs between the claim and the asset update", names.indexOf("tx.update:deprec") < names.indexOf("journal") && names.indexOf("journal") < names.indexOf("tx.update:assets"), names.join(","));
// 2. journal returns false -> rollback, journal_failed, asset update never attempted
setup(); r = await postDepreciationPeriod(1, 5, { postJournalInTx: async () => false });
check("journal false -> journal_failed + rollback, no asset update", r.status === "journal_failed" && ev(globalThis.__log).includes("tx:rollback") && !globalThis.__log.some(([a]) => a === "tx.update:assets"), ev(globalThis.__log));
// 3. journal throws -> rollback and the error propagates (not swallowed, not mapped)
setup(); let threw = null; try { await postDepreciationPeriod(1, 5, { postJournalInTx: async () => { throw new Error("db down"); } }); } catch (e) { threw = e; }
check("thrown error -> rollback and rethrown", threw?.message === "db down" && ev(globalThis.__log).includes("tx:rollback"), ev(globalThis.__log));
// 4. lost claim (concurrent winner) -> no journal, no asset update, returns the current row
setup({ txUpdates: [[]], txSelects: [[{ ...row, status: "posted" }]] }); let called = false;
r = await postDepreciationPeriod(1, 5, { postJournalInTx: async () => { called = true; return true; } });
check("lost claim -> returns posted row, journal not attempted, no asset update", r.status === "ok" && r.row.status === "posted" && !called && !globalThis.__log.some(([a]) => a === "tx.update:assets"), ev(globalThis.__log));
// 5. already posted -> early return, no transaction at all
setup(); globalThis.__selects = [[{ ...row, status: "posted" }]]; r = await postDepreciationPeriod(1, 5);
check("already posted -> no transaction", r.status === "ok" && !globalThis.__log.some(([a]) => a === "tx"), ev(globalThis.__log));
// 6. not found / asset missing
setup(); globalThis.__selects = [[]]; r = await postDepreciationPeriod(1, 5); check("missing period -> not_found", r.status === "not_found");
setup(); globalThis.__selects = [[row], []]; r = await postDepreciationPeriod(1, 5); check("missing asset -> asset_not_found, no transaction", r.status === "asset_not_found" && !globalThis.__log.some(([a]) => a === "tx"));
for (const x of results) console.log((x.ok ? "PASS " : "FAIL ") + x.name + (x.ok ? "" : "  -> " + x.extra));
process.exit(results.every((x) => x.ok) ? 0 : 1);
