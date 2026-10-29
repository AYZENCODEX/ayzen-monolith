// MKT-01a: static characterization tests. Plain `node --test` (no install, no database, no build).
// Part 1 tests the extractors on planted text. Part 2 compares the tree to pins.json. Part 3 names the money-safety facts
// (good and defective) that every later Marketplace move must keep or change only by a listed behavior change.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectFacts, routeSlices, sqlishLiterals, unrolledEarlyReturns, debitGuards, feeConstants, feePolicyBindings, kernelMoneyCalls, percentExpressions, responseShapes, routeDir, stringLiterals, stripComments, txSequence, writeSequence } from "./extract.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pins = JSON.parse(fs.readFileSync(path.join(here, "pins.json"), "utf8"));
const facts = collectFacts();
const src = (f) => stripComments(fs.readFileSync(path.join(routeDir, f), "utf8"));

// ---- Part 1: extractors ----
test("stripComments removes comments but keeps URLs inside strings and line count", () => {
  const t = 'const a = "http://x.y"; // gone\n/* block\n gone */ const b = 1;\n';
  const out = stripComments(t);
  assert.ok(out.includes('"http://x.y"')); assert.ok(!out.includes("gone")); assert.equal(out.split("\n").length, t.split("\n").length);
});
test("feeConstants and percentExpressions", () => {
  assert.deepEqual(feeConstants("const PLATFORM_FEE_PCT = 5;\nconst FEE_PCT = 2.5;\nconst OTHER = 3;"), { PLATFORM_FEE_PCT: 5, FEE_PCT: 2.5 });
  assert.deepEqual(percentExpressions("const fee = price * feePct / 100;\nconst x = 1;"), ["const fee = price * feePct / 100;"]);
});
test("writeSequence keeps order, ignores SELECT, collapses repeats", () => {
  assert.deepEqual(writeSequence("INSERT INTO a (x) VALUES (1); UPDATE credits SET n=1; UPDATE credits SET n=2; SELECT * FROM b; DELETE FROM c"), ["INSERT a", "UPDATE credits", "DELETE c"]);
});
test("txSequence reports BEGIN, locks by table, COMMIT, ROLLBACK in source order", () => {
  const code = 'await client.query("BEGIN"); await client.query("SELECT 1 FROM marketplace_wallets WHERE id=$1 FOR UPDATE"); await client.query("COMMIT"); await client.query("ROLLBACK");';
  assert.deepEqual(txSequence(code), ["BEGIN", "LOCK:marketplace_wallets", "COMMIT", "ROLLBACK"]);
});
test("debitGuards separates guarded from unguarded debits (quotes inside the SQL are handled)", () => {
  const code = `"UPDATE w SET balance=balance-$1 WHERE m='azn' AND balance >= $1"; "UPDATE w SET balance=balance-$1 WHERE m='azn'"; "UPDATE w SET balance=balance+$1"`;
  assert.deepEqual(debitGuards(code), { debits: 2, guarded: 1 });
});
test("responseShapes reads status and top-level keys", () => {
  const code = 'res.status(201).json({ order: o, message: "x" }); res.json({ ok: true, ...rest }); res.status(404).json({ error: "nope" }); res.json(rows);';
  assert.deepEqual(responseShapes(code), ["200 <non-object>", "200 {...rest,ok}", "201 {message,order}", "404 {error}"]);
});
test("stringLiterals keeps SQL with nested quote types", () => {
  assert.deepEqual(stringLiterals(`a("x 'y' z", 'w', \`t\`)`), ["x 'y' z", "w", "t"]);
});

// ---- Part 2: the tree equals the pins ----
function diff(expected, actual) {
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort(), out = [];
  for (const k of keys) if (JSON.stringify(expected[k]) !== JSON.stringify(actual[k])) out.push(`${k}\n  pinned: ${JSON.stringify(expected[k])}\n  now:    ${JSON.stringify(actual[k])}`);
  return out;
}
const section = (name) => Object.fromEntries(Object.entries(facts.files).map(([f, v]) => [f, v[name]]));
const pinned = (name) => Object.fromEntries(Object.entries(pins.files).map(([f, v]) => [f, v[name]]));
for (const name of ["feeConstants", "feePolicyBindings", "kernelMoneyCalls", "percentExpressions", "roundingSites", "statusLiterals", "debitGuards", "lockOrderInFile"]) {
  test(`pinned ${name} per route file`, () => assert.deepEqual(diff(pinned(name), section(name)), [], `${name} changed: update pins only for an intended, reviewed change (write-pins.mjs)`));
}
test("pinned write order, transaction/lock order and response shapes per route", () => assert.deepEqual(diff(pins.routes, facts.routes), [], "route write/tx/response facts changed: lock order and write order are behavior"));
test("pinned response shapes of the routes that neither write nor use a transaction (MKT-05 read routes)", () => assert.deepEqual(diff(pins.readOnlyRoutes, facts.readOnlyRoutes), [], "a read route changed its status codes or response keys"));
test("MKT-05: the SQL of every moved route is exactly the SQL that was in the route file before the move", () => {
  const moved = JSON.parse(fs.readFileSync(path.join(here, "moved-sql.pins.json"), "utf8")).files;
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const isStatement = (s) => /^(SELECT|UPDATE|INSERT|DELETE)\b/i.test(s);
  for (const [key, entry] of Object.entries(moved)) {
    const routeFile = entry.routeFile ?? key;
    const pick = entry.filter === "sqlish" ? (code) => sqlishLiterals(code) : (code) => stringLiterals(code).map(norm).filter(isStatement);
    const now = entry.repos.flatMap((r) => pick(stripComments(fs.readFileSync(path.join(here, "../../../../artifacts/api-server/src", r), "utf8"))));
    assert.deepEqual([...now].sort(), [...entry.statements].sort(), `${entry.repos.join(" + ")} must hold the statements of ${key}`);
    const code = src(routeFile);
    if (entry.routes) {
      const slices = routeSlices(code);
      for (const k of entry.routes) { assert.ok(slices[k], `${routeFile} still declares ${k}`); assert.equal(pick(slices[k]).length, 0, `${k} contains no SQL any more`); }
    } else assert.equal(pick(code).length, 0, `${routeFile} contains no SQL any more`);
  }
});
test("REAL float32 columns include the money columns", () => assert.deepEqual(facts.realFloatColumns, pins.realFloatColumns));

// ---- Part 3: named money-safety facts ----
const R = (k) => facts.routes[k];
test("fee percentages come from the kernel and equal the constants the audit recorded (D1 starts from these defaults)", () => {
  const kernel = fs.readFileSync(path.join(here, "../../../../artifacts/api-server/src/marketplace/kernel/domain/fee-policy.ts"), "utf8");
  const body = kernel.slice(kernel.indexOf("DEFAULT_FEE_PCT = Object.freeze({"), kernel.indexOf("});", kernel.indexOf("DEFAULT_FEE_PCT = Object.freeze({")));
  const defaults = Object.fromEntries([...body.matchAll(/(\w+):\s*([\d.]+),/g)].map((m) => [m[1], Number(m[2])]));
  assert.deepEqual(defaults, { p2p: 5, cart: 5, bundle: 5, offer: 5, azn: 2.5, usdt: 2.5, nft: 3, spot: 0.1 });
  const want = { "marketplace.ts": ["p2p"], "marketplace-cart.ts": ["cart"], "marketplace-bundles.ts": ["bundle"], "marketplace-offers.ts": ["offer"], "marketplace-azn.ts": ["azn"], "marketplace-usdt.ts": ["usdt"], "marketplace-nft.ts": ["nft"], "marketplace-spot.ts": ["spot"] };
  for (const [f, markets] of Object.entries(want)) {
    assert.deepEqual(Object.values(facts.files[f].feePolicyBindings), markets, `${f} binds its fee to the kernel`);
    assert.deepEqual(facts.files[f].feeConstants, {}, `${f} declares no numeric fee constant any more`);
  }
});
test("every credits and builtin_wallet_tokens write in the routes has a twin statement in the kernel adapters (D2)", () => {
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const adapterDir = path.join(here, "../../../../artifacts/api-server/src/marketplace/kernel/infrastructure");
  const adapter = new Set([...stringLiterals(stripComments(fs.readFileSync(path.join(adapterDir, "credits-adapter.ts"), "utf8"))), ...stringLiterals(stripComments(fs.readFileSync(path.join(adapterDir, "token-wallet-adapter.ts"), "utf8")))].map(norm));
  const routeWrites = new Set();
  for (const f of fs.readdirSync(routeDir).filter((x) => /^marketplace/.test(x))) for (const s of stringLiterals(src(f))) {
    const n = norm(s);
    if ((/\b(UPDATE|INSERT INTO)\s+credits\b/i.test(n) || /\b(UPDATE|INSERT INTO)\s+builtin_wallet_tokens\b/i.test(n)) ) routeWrites.add(n);
  }
  const missing = [...routeWrites].filter((s) => !adapter.has(s));
  assert.deepEqual(missing, [], "route statement without an adapter twin");
  assert.equal(routeWrites.size, 10);
});
test("GOOD: wallet deposit/withdraw debits are guarded and run in a transaction", () => {
  assert.deepEqual(facts.files["marketplace-wallet.ts"].debitGuards, { debits: 2, guarded: 2 });
  assert.deepEqual(R("POST /marketplace/wallet/:type/withdraw marketplace-wallet.ts").tx.filter((e) => e === "BEGIN" || e === "COMMIT").sort(), ["BEGIN", "COMMIT"]);
});
test("GOOD: NFT buy sells the listing with a status guard and answers 409 when it was already sold", () => {
  const lit = stringLiterals(src("marketplace-nft.ts")).find((s) => /UPDATE nft_market_listings SET status='sold'/.test(s));
  assert.ok(lit && /status='active'/.test(lit) && /RETURNING id/.test(lit));
  assert.ok(R("POST /marketplace/nft/buy marketplace-nft.ts").responses.some((r) => r.startsWith("409")));
});
test("GOOD: cart checkout, offer accept and bundle buy lock rows (FOR UPDATE) inside a transaction", () => {
  for (const k of ["POST /marketplace/cart/checkout marketplace-cart.ts", "POST /marketplace/offers/:id/accept marketplace-offers.ts", "POST /marketplace/bundles/:id/buy marketplace-bundles.ts"]) {
    const tx = R(k).tx; assert.ok(tx.includes("BEGIN") && tx.includes("COMMIT") && tx.some((e) => e.startsWith("LOCK:")), k);
  }
});
test("GOOD: spot order placement locks wallet rows before COMMIT and keeps the lock order", () => {
  const tx = R("POST /spot/orders marketplace-spot.ts").tx;
  assert.equal(tx[0], "BEGIN"); assert.ok(tx.includes("COMMIT")); assert.ok(tx.some((e) => e.startsWith("LOCK:")));
  assert.deepEqual(facts.files["marketplace-spot.ts"].lockOrderInFile, pins.files["marketplace-spot.ts"].lockOrderInFile);
});
test("DEFECT PINNED (MKT-ISSUE-7): P2P buy inserts the order and debits credits with no transaction and no balance guard", () => {
  const r = R("POST /marketplace/listings/:id/buy marketplace.ts");
  assert.deepEqual(r.writes, ["INSERT marketplace_orders", "UPDATE credits"]);
  assert.deepEqual(r.tx, []);
  const debit = stringLiterals(src("marketplace.ts")).find((s) => /UPDATE credits SET azn_balance = azn_balance - \$1/.test(s));
  assert.ok(debit && !/>=/.test(debit), "the escrow debit has no `azn_balance >=` predicate");
});
test("DEFECT PINNED (MKT-ISSUE-6): AZN and USDT buy read the listing outside the transaction and update it without a status/amount guard; the seller locked_balance debit is unguarded", () => {
  for (const [f, route, table] of [["marketplace-azn.ts", "POST /marketplace/azn/buy marketplace-azn.ts", "azn_listings"], ["marketplace-usdt.ts", "POST /marketplace/usdt/buy marketplace-usdt.ts", "usdt_listings"]]) {
    assert.ok(!R(route).tx.some((e) => e.startsWith("LOCK:")), `${f}: no row lock`);
    const lits = stringLiterals(src(f));
    const partial = lits.find((s) => new RegExp(`UPDATE ${table} SET amount=\\$1`).test(s));
    assert.ok(partial && !/status\s*=/.test(partial) && !/amount\s*=\s*\$\d\s*(?:AND|$)/.test(partial.split("WHERE")[1] ?? ""), `${f}: partial-fill update has no guard`);
    const sellerDebit = lits.find((s) => /locked_balance=locked_balance-\$1/.test(s));
    assert.ok(sellerDebit && !/locked_balance\s*>=/.test(sellerDebit), `${f}: seller locked_balance debit has no guard`);
    assert.equal(facts.files[f].debitGuards.guarded >= 1, true, `${f}: the buyer debit is guarded (balance >= $1)`);
  }
});
test("unrolledEarlyReturns finds a return inside a transaction that has no ROLLBACK", () => {
  const bad = 'await c.query("BEGIN");\nif (x) { res.status(404).json({}); return; }\nawait c.query("COMMIT");';
  const good = 'await c.query("BEGIN");\nif (x) { await c.query("ROLLBACK"); res.status(404).json({}); return; }\nawait c.query("COMMIT");';
  assert.equal(unrolledEarlyReturns(bad).length, 1);
  assert.equal(unrolledEarlyReturns(good).length, 0);
  assert.deepEqual(unrolledEarlyReturns("no transaction here;\nreturn;"), []);
});
test("DEFECT PINNED (MKT-ISSUE-8): exactly one early return inside a transaction skips ROLLBACK, PATCH /admin/marketplace/orders/:id", () => {
  const found = Object.entries(facts.routes).filter(([, v]) => v.unrolledEarlyReturns).map(([k]) => k);
  assert.deepEqual(found, ["PATCH /admin/marketplace/orders/:id marketplace.ts"]);
});
test("DEFECT PINNED (MKT-ISSUE-9): NFT buy credits the seller with an UPDATE only; no code path creates the seller's nft wallet", () => {
  const route = R("POST /marketplace/nft/buy marketplace-nft.ts");
  assert.ok(route.writes.includes("UPDATE marketplace_wallets") && !route.writes.includes("INSERT marketplace_wallets"));
  const code = src("marketplace-nft.ts");
  assert.equal((code.match(/\bensureWallet\(/g) || []).length, 2, "the definition and the single call, with the buyer id");
  assert.match(code, /ensureWallet\(buyerId\)/);
  const mint = stringLiterals(code).find((s) => /INSERT INTO nft_market_listings/.test(s));
  assert.ok(mint && !/marketplace_wallets/.test(mint), "minting a listing does not touch wallets");
});
test("REAL float32 columns include the money columns", () => {
  for (const c of ["marketplace_wallets.balance", "marketplace_wallets.locked_balance", "marketplace_listings.price_azn", "marketplace_orders.price_azn"]) assert.ok(facts.realFloatColumns.includes(c), c);
});
