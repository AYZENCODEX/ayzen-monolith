import assert from "node:assert/strict";
import {
  createServiceRegistry,
  createStartupOrchestrator,
  validateEnvironment,
  runCleanBootGate,
  createMigrationRegistry,
  runDeterministicMigrations,
  detectSchemaDrift,
  createEndpointInventory,
  createTelegramCommandCatalog,
  authorizeTelegramCommand,
  createAdminPolicy,
  createOperationPreview,
  createSharedDataBoundary,
  createAccessBoundary,
  createServiceScopePolicy,
  createAppPolicy,
  validateOidcBoundary,
  createEventSchemaRegistry,
  createWorkflowOrchestrator,
  createDlqRecovery,
  createCanonicalContext,
  propagateContext,
  validateServiceContext,
  getFeatureContext,
  diagnoseContext,
  runContextSecurityChecks,
  createResourceRegistry,
  createDependencyGraph,
  compareRuntimeDeclared,
  createConfigurationEngine,
  listXukaPhases,
  getXukaImplementationSnapshot,
} from "../packages/xuka/src/index.mjs";

const firstEighty = listXukaPhases().filter((phase) => phase.phase <= 80);
assert.equal(firstEighty.length, 80, "XUKA phases 1-80 must be registered");
assert.deepEqual(firstEighty.map((phase) => phase.phase), Array.from({ length: 80 }, (_, index) => index + 1));

const registry = createServiceRegistry([
  { name: "database", port: 5432, owner: "platform", routePrefixes: [] },
  { name: "gateway", port: 5000, owner: "platform", routePrefixes: ["/api"], dependsOn: ["database"] },
]);
assert.equal(registry.resolveRoute("/api/admin")?.name, "gateway");
assert.deepEqual(createStartupOrchestrator({ registry }).plan().map((item) => item.service), ["database", "gateway"]);
assert.equal(validateEnvironment({ schema: [{ name: "NODE_ENV", required: true }], environment: { NODE_ENV: "test" } }).valid, true);
assert.equal(runCleanBootGate({ checks: [{ name: "config", passed: true }, { name: "auth", passed: false }] }).ok, false);

const migrationRegistry = createMigrationRegistry([
  { id: "001-base", service: "identity" },
  { id: "002-index", service: "identity", dependsOn: ["001-base"] },
]);
const executed = [];
const migrationResult = await runDeterministicMigrations({ registry: migrationRegistry, execute: async (migration) => executed.push(migration.id) });
assert.deepEqual(executed, ["001-base", "002-index"]);
assert.deepEqual(migrationResult.applied, ["001-base", "002-index"]);
assert.deepEqual(detectSchemaDrift({ expected: ["users"], actual: ["users", "legacy"] }), { drift: true, missing: [], unexpected: ["legacy"] });

const endpoints = createEndpointInventory();
assert.ok(endpoints.count >= 30, "API endpoint inventory should include XUKA admin operations");
const telegram = createTelegramCommandCatalog();
assert.ok(telegram.count >= 70, "Telegram command catalog should include product and admin bots");
assert.equal(authorizeTelegramCommand({ bot: "admin", command: "/health", adminOwner: false }).allowed, false);
assert.equal(authorizeTelegramCommand({ bot: "admin", command: "/health", adminOwner: true, scopes: ["admin:read"] }).allowed, true);

const policy = createAdminPolicy({ roles: { owner: ["admin:read", "admin:write"], auditor: ["admin:read"] } });
assert.equal(policy.authorize({ role: "auditor", scope: "admin:write", resource: "users", action: "update" }).allowed, false);
assert.equal(createOperationPreview({ operation: "update", resource: "users", changes: { name: "safe" }, policy, auth: { role: "owner", scope: "admin:write" } }).requiresConfirmation, true);
assert.equal(createSharedDataBoundary({ shared: { tenant_context: { owner: "platform", actions: ["read"] } } }).inspect("tenant_context", "write").allowed, false);

const snapshot = getXukaImplementationSnapshot();
assert.equal(createAccessBoundary({ owner: "finance", resources: ["finance_accounts"], operations: ["read"] }).allows({ resource: "users" }).allowed, false);
assert.equal(createServiceScopePolicy({ scopes: { gateway: ["finance:read"] } }).authorize({ service: "gateway", scope: "finance:write" }).allowed, false);
assert.equal(createAppPolicy({ app: "ryft", rules: { read: true } }).authorize({ action: "write" }).allowed, false);
assert.equal(validateOidcBoundary({ issuer: "http://issuer", audience: "app", redirectUris: ["https://app/callback"] }).valid, false);
const schemas = createEventSchemaRegistry({ definitions: [{ type: "user.created", version: 1, owner: "identity", required: ["id"] }] });
assert.equal(schemas.validate("user.created", 1, {}).valid, false);
assert.equal((await createWorkflowOrchestrator({ steps: [{ id: "one" }], execute: async () => "ok" }).run()).ok, true);
const dlq = createDlqRecovery();
const dlqEntry = dlq.push({ eventType: "user.created" }, "temporary");
assert.equal((await dlq.recover(dlqEntry.id, async () => undefined)).recovered, true);
const context = createCanonicalContext({ requestId: "req-1", traceId: "trace-1", correlationId: "corr-1", organizationId: "org-1" });
assert.equal(validateServiceContext({ context, service: "finance" }).valid, true);
assert.equal(propagateContext(context).organizationId, "org-1");
assert.equal(getFeatureContext(context, "billing").allowed, true);
assert.equal(diagnoseContext(context).valid, true);
assert.equal(runContextSecurityChecks({ contexts: [context], allowedOrganizations: ["org-1"] }).valid, true);
const resources = createResourceRegistry({ resources: [{ id: "org-1", owner: "workspace" }, { id: "ws-1", owner: "workspace", parentId: "org-1" }] });
assert.equal(resources.hierarchy("ws-1").length, 2);
assert.equal(resources.orphans().length, 0);
const graph = createDependencyGraph({ nodes: ["a", "b", "c"], edges: [["a", "b"], ["b", "c"]] });
assert.deepEqual(graph.impact("a"), ["b", "c"]);
assert.deepEqual(compareRuntimeDeclared({ declared: ["a"], runtime: ["a", "b"] }).runtimeOnly, ["b"]);
const config = createConfigurationEngine({ schema: { mode: { type: "string", required: true } }, initial: { mode: "safe" } });
assert.equal(config.update({ mode: "strict" }, { confirmation: true }).version, 1);
assert.equal(config.rollback(1, { confirmation: true }).rolledBack, true);
assert.equal(snapshot.phases.filter((phase) => phase.phase <= 80).length, 80);
assert.equal(snapshot.evidence.database.sharedBoundary, true);
assert.equal(snapshot.evidence.configuration.ui, true);
console.log(`XUKA phases 1-80 validation passed (${snapshot.evidence.api.endpoints} endpoints, ${snapshot.evidence.telegram.commands} Telegram commands)`);