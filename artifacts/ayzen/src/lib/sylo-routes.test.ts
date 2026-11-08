import assert from "node:assert/strict";
import test from "node:test";
import {
  ACCOUNT_SECTIONS, ACCOUNT_VIEWS, accountPath, isAccountSection, isAccountView, resolveLegacyTab,
} from "./sylo-routes";

test("accountPath builds /vault/account/:section/:view, defaulting to home", () => {
  assert.equal(accountPath("entity"), "/vault/account/entity/home");
  assert.equal(accountPath("kyc", "analysis"), "/vault/account/kyc/analysis");
});

test("every generated path stays inside Sylo's /vault route prefix", () => {
  for (const s of ACCOUNT_SECTIONS) for (const v of ACCOUNT_VIEWS) assert.ok(accountPath(s, v).startsWith("/vault/"));
});

test("type guards reject unknown segments (used to 404 bad URLs)", () => {
  assert.equal(isAccountSection("entity"), true);
  assert.equal(isAccountSection("wallet"), false);
  assert.equal(isAccountSection(undefined), false);
  assert.equal(isAccountView("analysis"), true);
  assert.equal(isAccountView("settings"), false);
});

test("legacy ?tab= for entity/local/kyc keeps the old Dashboard landing", () => {
  assert.equal(resolveLegacyTab("?tab=entity"), "/vault/account/entity/dashboard");
  assert.equal(resolveLegacyTab("?tab=local"), "/vault/account/local/dashboard");
  assert.equal(resolveLegacyTab("tab=kyc"), "/vault/account/kyc/dashboard", "leading ? is optional (wouter's useSearch omits it)");
});

test("legacy editId opens the editor and survives the redirect", () => {
  assert.equal(resolveLegacyTab("?tab=entity&editId=42"), "/vault/account/entity/management?editId=42");
});

test("legacy tabs that moved elsewhere map to their new homes", () => {
  assert.equal(resolveLegacyTab("?tab=game"), "/vault/account/game/management");
  assert.equal(resolveLegacyTab("?tab=wallet"), "/vault/wallet-hub/wallet");
  assert.equal(resolveLegacyTab("?tab=mail&view=settings"), "/vault/mail-hub/entity", "the old in-tab `view` has no equivalent and is dropped");
});

test("no tab (or an unknown one) means 'show the Console'", () => {
  assert.equal(resolveLegacyTab(""), null);
  assert.equal(resolveLegacyTab("?foo=bar"), null);
  assert.equal(resolveLegacyTab("?tab=nonsense"), null);
});
