import test from "node:test";
import assert from "node:assert/strict";
import { creditsAdapter, CREDITS_SQL } from "./credits-adapter";
import { tokenWalletAdapter, TOKEN_SQL } from "./token-wallet-adapter";
import { effectiveFeePct, FEE_FROM_CONFIG_FLAG, loadFeeSources } from "./fee-settings-repo";

type Call = { text: string; params?: unknown[] };
function db(rowsFor: (text: string) => any[] = () => [], rowCount = 1) {
  const calls: Call[] = [];
  return { calls, query: async (text: string, params?: unknown[]) => { calls.push({ text, params }); return { rows: rowsFor(text), rowCount }; } };
}

test("credits adapter runs the route statements with the route parameter order", async () => {
  const d = db();
  await creditsAdapter.debitAznUnguarded(d, 7, 12.5);
  await creditsAdapter.creditAzn(d, 8, 3);
  await creditsAdapter.creditAznUpsert(d, 9, 4);
  await creditsAdapter.creditAznUpsertNewUser(d, 10, 5);
  assert.deepEqual(d.calls, [
    { text: CREDITS_SQL.debitAznUnguarded, params: [12.5, 7] },
    { text: CREDITS_SQL.creditAzn, params: [3, 8] },
    { text: CREDITS_SQL.creditAznUpsert, params: [9, 4] },
    { text: CREDITS_SQL.creditAznUpsertNewUser, params: [10, 5] },
  ]);
});
test("guarded debit reports whether a row was debited", async () => {
  assert.equal(await creditsAdapter.debitAznGuarded(db(() => [], 1), 1, 5), true);
  assert.equal(await creditsAdapter.debitAznGuarded(db(() => [], 0), 1, 5), false);
});
test("token wallet adapter parameter order", async () => {
  const d = db((t) => (t === TOKEN_SQL.lockUsdtRow ? [{ amount: 1, locked_amount: 2 }] : []));
  await tokenWalletAdapter.ensureUsdtRow(d, 1);
  assert.deepEqual(await tokenWalletAdapter.lockUsdtRow(d, 2), { amount: 1, locked_amount: 2 });
  await tokenWalletAdapter.addLockedUsdt(d, 3, 10);
  await tokenWalletAdapter.releaseLockedUsdt(d, 4, 11);
  await tokenWalletAdapter.creditUsdt(d, 5, 12);
  await tokenWalletAdapter.debitUsdt(d, 6, 13);
  assert.deepEqual(d.calls.map((c) => c.params), [[1], [2], [10, 3], [11, 4], [5, 12], [13, 6]]);
});
test("fee from config is OFF by default: today's constant and no query at all", async () => {
  const d = db();
  assert.equal(await effectiveFeePct(d, "p2p", {}), 5);
  assert.equal(await effectiveFeePct(d, "spot", { [FEE_FROM_CONFIG_FLAG]: "0" }), 0.1);
  assert.equal(d.calls.length, 0);
});
test("fee from config ON: market config, then legacy settings for the P2P family, then default", async () => {
  const rows = (t: string) => t.includes("marketplace_market_configs") ? [{ market_type: "azn", fee_pct: "4", enabled: true }] : t.includes("marketplace_settings") ? [{ fee_pct: 8, enabled: true }] : [];
  const env = { [FEE_FROM_CONFIG_FLAG]: "1" };
  assert.equal(await effectiveFeePct(db(rows), "azn", env), 4);
  assert.equal(await effectiveFeePct(db(rows), "p2p", env), 8);
  assert.equal(await effectiveFeePct(db(rows), "nft", env), 3);
  const sources = await loadFeeSources(db(rows));
  assert.equal(sources.marketConfigs?.azn?.fee_pct, "4");
});
