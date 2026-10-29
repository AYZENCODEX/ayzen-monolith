import assert from "node:assert/strict";
import {
  createCredentialLifecycleEngine,
  createVersionCompatibilityEngine,
  createKnowledgeGraphEngine,
  createProductionGapClosureEngine,
  createFrontendVerificationPlan,
  getXukaImplementationSnapshot,
  listXukaPhases,
} from "../packages/xuka/src/index.mjs";

const phases = listXukaPhases();
assert.equal(phases.length, 156, "XUKA phases 1-156 must be registered");
assert.deepEqual(phases.slice(80).map((phase) => phase.phase), Array.from({ length: 76 }, (_, index) => index + 81));
assert.equal(phases.filter((phase) => phase.phase >= 81 && phase.phase <= 156).length, 76);

const credentials = createCredentialLifecycleEngine({ credentials: [{ id: "cred-1", name: "api", owner: "admin", service: "gateway" }] });
assert.equal(credentials.generate("cred-1").secretPresent, true);
assert.equal(credentials.rotate("cred-1").rotated, true);
assert.equal(credentials.revoke("cred-1").revoked, true);
assert.equal(credentials.serviceIdentity("cred-1").active, false);
assert.ok(credentials.audit().length >= 4);

const compatibility = createVersionCompatibilityEngine({
  versions: [{ id: "v1", name: "api", version: 1 }],
  rules: [{ from: "v1", to: "v2", allowed: true }],
  consumers: [{ id: "web", version: "v1" }],
});
compatibility.registerVersion({ id: "v2", name: "api", version: 2 });
assert.equal(compatibility.detectBreakingChanges({ id: "string", name: "string" }, { id: "string" }).breaking, true);
assert.equal(compatibility.releaseGate("v1", "v2", { previousSchema: { id: "string" }, nextSchema: { id: "string" } }).passed, true);
assert.equal(compatibility.migration("web", "v1", "v2").planned, false);
assert.equal(compatibility.migration("web", "v1", "v2", { confirmation: true }).planned, true);
assert.equal(compatibility.deprecate("v1", { replacement: "v2" }).status, "deprecated");

const graph = createKnowledgeGraphEngine({
  entities: [{ id: "service-a", kind: "service" }, { id: "db-a", kind: "database" }, { id: "secret-a", kind: "secret" }],
  relationships: [{ from: "service-a", to: "db-a", type: "depends-on" }],
  authorize: ({ node }) => node?.kind !== "secret",
});
graph.relate({ from: "db-a", to: "secret-a", type: "uses" });
assert.equal(graph.traverse("service-a", { depth: 2 }).nodes.length, 2);
assert.equal(graph.authorize("operator", "secret-a"), false);

const gap = createProductionGapClosureEngine();
assert.equal(gap.observability({ passed: true }).passed, true);
assert.equal(gap.securityRegression({ items: [{ passed: true }] }).passed, true);
assert.equal(gap.architectureAudit({ required: ["db"], checks: { db: true } }).passed, true);
assert.equal(gap.summary().passed, true);

const frontend = createFrontendVerificationPlan({
  routes: [{ path: "/admin/xuka", authorization: "admin" }],
  contracts: [{ name: "registry", path: "/api/admin/xuka/registry" }],
});
assert.equal(frontend.validate().valid, true);
assert.ok(frontend.uiModel()[0].states.includes("permission-denied"));

const evidence = getXukaImplementationSnapshot().evidence;
for (const area of ["credentials", "compatibility", "knowledgeGraph", "productionGapClosure", "frontend"]) {
  assert.ok(evidence[area], `Missing XUKA evidence area: ${area}`);
  assert.ok(Object.values(evidence[area]).every(Boolean), `Incomplete XUKA evidence area: ${area}`);
}

console.log(`XUKA phases 81-156 validation passed (${phases.length} phases, ${Object.keys(evidence).length} evidence areas)`);