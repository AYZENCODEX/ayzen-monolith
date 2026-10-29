import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const fabric = JSON.parse(fs.readFileSync(path.join(root, "infrastructure/platform/connection-fabric.json"), "utf8"));
assert.deepEqual(fabric.rules.allowedTransports.sort(), ["api", "eventbus"]);
assert.equal(fabric.rules.directDatabaseAccess, false);
for (const requirement of ["audience", "scope", "resource", "traceId", "correlationId", "audit"]) {
  assert.ok(fabric.rules.crossAppCallsRequire.includes(requirement), `cross-app requirement missing: ${requirement}`);
}
for (const requirement of ["tenantScope", "traceContext", "consentOrPolicy"]) {
  assert.ok(fabric.rules.crossChannelRequires.includes(requirement), `cross-channel requirement missing: ${requirement}`);
}
const endpoints = new Set([...fabric.channels, ...fabric.apps, ...fabric.bots]);
assert.ok(fabric.connections.length >= 10, "connection fabric is too small");
for (const connection of fabric.connections) {
  assert.ok(endpoints.has(connection.from), `unregistered source: ${connection.from}`);
  assert.ok(endpoints.has(connection.to), `unregistered target: ${connection.to}`);
  assert.ok(["api", "eventbus"].includes(connection.transport), `unsafe transport: ${connection.transport}`);
  assert.ok(Array.isArray(connection.scopes) && connection.scopes.length > 0, `${connection.from}->${connection.to}: scope missing`);
  assert.ok(Array.isArray(connection.resources) && connection.resources.includes("tenant"), `${connection.from}->${connection.to}: tenant resource missing`);
}
assert.ok(fabric.connections.some((connection) => connection.from === "web" && connection.to === "api-gateway"));
assert.ok(fabric.connections.some((connection) => connection.from === "api-gateway" && connection.to === "notification" && connection.transport === "eventbus"));
assert.ok(fabric.connections.some((connection) => connection.from === "admin-bot" && connection.to === "admin"));
// Deployment wiring: every deployed app that declares an event-bus dependency
// must have EVENT_BUS_HTTP_URL and/or EVENT_BUS_REDIS_URL in its compose
// service (H5.1 split EVENT_BUS_URL, which used to double as both the HTTP
// base URL and the raw Redis connection string, into the two dedicated
// vars), and telegram-gateway must have TELEGRAM_HANDLER_URL (Roadmap A2 /
// D4 gates).
const composePath = path.join(root, "infrastructure/docker/docker-compose.yml");
const compose = fs.readFileSync(composePath, "utf8");
const serviceBlocks = new Map();
{
  let current = null;
  let inServices = false;
  for (const line of compose.split("\n")) {
    if (/^services:\s*$/.test(line)) { inServices = true; continue; }
    if (/^\S/.test(line)) inServices = false;
    if (!inServices) continue;
    const header = line.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (header) { current = header[1]; serviceBlocks.set(current, ""); continue; }
    if (current) serviceBlocks.set(current, `${serviceBlocks.get(current)}${line}\n`);
  }
}
for (const dir of ["apps", "services"]) {
  if (!fs.existsSync(path.join(root, dir))) continue;
  for (const name of fs.readdirSync(path.join(root, dir))) {
    const entry = path.join(root, dir, name, "src/index.mjs");
    if (!fs.existsSync(entry)) continue;
    if (!/eventBus:\s*true/.test(fs.readFileSync(entry, "utf8"))) continue;
    // Match on the package's declared name, not the directory name — under
    // services/*, e.g. directory "finance" is package "@ayzen/finance-service".
    const pkgPath = path.join(root, dir, name, "package.json");
    const pkgName = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, "utf8")).name : `@ayzen/${name}`;
    const deployed = [...serviceBlocks.entries()].filter(([, block]) => block.includes(`"${pkgName}"`));
    assert.ok(deployed.length > 0, `${dir}/${name} (${pkgName}) declares an eventBus dependency but has no docker-compose service deploying it`);
    for (const [serviceName, block] of deployed) {
      assert.ok(
        /EVENT_BUS_HTTP_URL:\s*\S+/.test(block) || /EVENT_BUS_REDIS_URL:\s*\S+/.test(block),
        `compose service ${serviceName} (${dir}/${name}) declares eventBus dependency but has neither EVENT_BUS_HTTP_URL nor EVENT_BUS_REDIS_URL`,
      );
    }
  }
}
const telegramBlock = [...serviceBlocks.entries()].find(([, block]) => block.includes('"@ayzen/telegram-gateway"'));
assert.ok(telegramBlock, "telegram-gateway is not deployed in docker-compose.yml");
assert.ok(/TELEGRAM_HANDLER_URL:\s*https?:\/\/\S+/.test(telegramBlock[1]), "telegram-gateway compose service has no resolvable TELEGRAM_HANDLER_URL");
const workerBlock = [...serviceBlocks.entries()].find(([, block]) => block.includes('"@ayzen/worker"'));
assert.ok(workerBlock, "worker is not deployed in docker-compose.yml");
console.log(`Connectivity fabric passed (${fabric.connections.length} registered connections)`);