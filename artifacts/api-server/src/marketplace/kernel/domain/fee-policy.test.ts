import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FEE_PCT, P2P_FAMILY, resolveFeePct } from "./fee-policy";

test("defaults equal the constants the route files declared before MKT-03", () => {
  assert.deepEqual({ ...DEFAULT_FEE_PCT }, { p2p: 5, cart: 5, bundle: 5, offer: 5, azn: 2.5, usdt: 2.5, nft: 3, spot: 0.1 });
  assert.ok(Object.isFrozen(DEFAULT_FEE_PCT));
});
test("no sources: the default", () => {
  for (const m of Object.keys(DEFAULT_FEE_PCT) as Array<keyof typeof DEFAULT_FEE_PCT>) assert.equal(resolveFeePct(m), DEFAULT_FEE_PCT[m]);
});
test("a market config row wins over the legacy settings row and the default", () => {
  assert.equal(resolveFeePct("p2p", { marketConfigs: { p2p: { fee_pct: 7 } }, legacySettings: { fee_pct: 9 } }), 7);
});
test("legacy marketplace_settings applies to the P2P family only", () => {
  for (const m of P2P_FAMILY) assert.equal(resolveFeePct(m, { legacySettings: { fee_pct: 9 } }), 9);
  for (const m of ["azn", "usdt", "nft", "spot"] as const) assert.equal(resolveFeePct(m, { legacySettings: { fee_pct: 9 } }), DEFAULT_FEE_PCT[m]);
});
test("database strings are accepted; invalid, negative, over-100 and missing values fall through to the next source", () => {
  assert.equal(resolveFeePct("azn", { marketConfigs: { azn: { fee_pct: "4.5" } } }), 4.5);
  for (const bad of [null, undefined, "", "abc", -1, 101, NaN]) assert.equal(resolveFeePct("azn", { marketConfigs: { azn: { fee_pct: bad as any } } }), 2.5, String(bad));
  assert.equal(resolveFeePct("p2p", { marketConfigs: { p2p: { fee_pct: "x" } }, legacySettings: { fee_pct: 6 } }), 6);
  assert.equal(resolveFeePct("p2p", { marketConfigs: { p2p: { fee_pct: 0 } } }), 0); // zero is a valid fee
});
