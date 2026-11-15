import assert from "node:assert/strict";
import { shouldShowModuleLanding, hasStoredToken, designHandoff, parseIdList } from "../../artifacts/ayzen/src/lib/module-landing-gate";

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

// central bundle on a module host -> the module's designed landing / own login (static /m/<id>/)
const h = { build: "sylo" as const, centralBuild: true, pathname: "/", hasToken: false, landingDesigns: ["sylo", "fyra"], loginDesigns: ["fyra"] };
assert.equal(designHandoff(h), "/m/sylo/");
assert.equal(designHandoff({ ...h, pathname: "", search: "?a=1", hash: "#x" }), "/m/sylo/?a=1#x");
assert.equal(designHandoff({ ...h, build: "fyra", pathname: "/login", search: "?next=%2Ffinance" }), "/m/fyra/login/?next=%2Ffinance");
assert.equal(designHandoff({ ...h, pathname: "/login" }), null, "sylo has no own login design -> SPA /login");
assert.equal(designHandoff({ ...h, build: "skarn" }), null, "no design -> generic fallback");
assert.equal(designHandoff({ ...h, hasToken: true }), null, "signed in -> app");
assert.equal(designHandoff({ ...h, centralBuild: false }), null, "module build already serves its landing");
assert.equal(designHandoff({ ...h, build: null }), null, "central host");
assert.equal(designHandoff({ ...h, enabled: false }), null, "kill switch");
assert.equal(designHandoff({ ...h, pathname: "/m/sylo/" }), null, "no loop");
assert.deepEqual(parseIdList("sylo, fyra,,"), ["sylo", "fyra"]);
assert.deepEqual(parseIdList(undefined), []);
console.log("module-landing-gate: all assertions passed");
