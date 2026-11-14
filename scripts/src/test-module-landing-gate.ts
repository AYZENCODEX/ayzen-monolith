import assert from "node:assert/strict";
import { shouldShowModuleLanding, hasStoredToken } from "../../artifacts/ayzen/src/lib/module-landing-gate";

const base = { build: "sylo" as const, pathname: "/", hasToken: false };
assert.equal(shouldShowModuleLanding(base), true);
assert.equal(shouldShowModuleLanding({ ...base, pathname: "" }), true);
assert.equal(shouldShowModuleLanding({ ...base, pathname: "//" }), true);
assert.equal(shouldShowModuleLanding({ ...base, hasToken: true }), false, "signed in -> app");
assert.equal(shouldShowModuleLanding({ ...base, build: null }), false, "central build -> no landing");
assert.equal(shouldShowModuleLanding({ ...base, pathname: "/login" }), false, "/login is the W1 login");
assert.equal(shouldShowModuleLanding({ ...base, pathname: "/vault" }), false);
assert.equal(shouldShowModuleLanding({ ...base, enabled: false }), false, "kill switch");
assert.equal(hasStoredToken([{ getItem: () => null }]), false);
assert.equal(hasStoredToken([{ getItem: () => null }, { getItem: (k: string) => (k === "ayzen_token" ? "x" : null) }]), true);
assert.equal(hasStoredToken([{ getItem: () => { throw new Error("blocked"); } }]), false);
console.log("module-landing-gate: all assertions passed");
