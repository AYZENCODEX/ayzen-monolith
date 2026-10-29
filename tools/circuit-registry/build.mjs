#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const endpointSource = fs.readFileSync(path.join(root, "packages/endpoint-registry/src/index.mjs"), "utf8");
const endpointEntries = [...endpointSource.matchAll(/\["([^"]+)",\s*"([A-Z]+)",\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)",\s*(true|false)\]/g)]
  .map(([, owner, method, route, auth, permission, audit, idempotent]) => ({ owner, method, route, auth, permission, audit, idempotent: idempotent === "true" }));

const serviceFiles = [];
function walk(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.name === "index.mjs" && file.includes(`${path.sep}services${path.sep}`)) serviceFiles.push(file);
  }
}
walk(path.join(root, "services"));
const services = new Map();
for (const file of serviceFiles) {
  const source = fs.readFileSync(file, "utf8");
  const service = source.match(/service:\s*"([^"]+)"/)?.[1];
  if (!service) continue;
  services.set(service, [...source.matchAll(/routePrefixes:\s*\[([^\]]*)\]/g)].flatMap((match) => [...match[1].matchAll(/"([^"]+)"/g)].map(([, route]) => route)));
}

const catalog = JSON.parse(fs.readFileSync(path.join(root, "infra/event-catalog/catalog.json"), "utf8"));
const circuits = endpointEntries.map((endpoint) => ({
  feature: `${endpoint.owner}.${endpoint.method.toLowerCase()}.${endpoint.route.replace(/^\/|\/$/g, "").replace(/[/:]/g, "-")}`,
  api: "api-gateway",
  service: endpoint.owner,
  data: endpoint.owner,
  route: `${endpoint.method} ${endpoint.route}`,
  auth: endpoint.auth,
  policy: endpoint.permission,
  audit: endpoint.audit,
  stages: ["feature", "per-service-api", "service", "app-owned-data", "router-policy", "audit"],
}));
for (const event of catalog.events ?? []) {
  circuits.push({
    feature: `event.${event.type}`,
    api: "event-gateway",
    service: event.owner,
    data: event.owner,
    event: event.type,
    consumers: event.consumers,
    stages: ["feature", "event-gateway", "eventbus", "consumer", "audit"],
  });
}

const knownServices = new Set(["identity", "finance", "vault", "mail", "workflow", "marketplace", "search", "intelligence", "admin", "notification", "ai-agent", "telegram-gateway"]);
const orphans = endpointEntries.filter((endpoint) => !knownServices.has(endpoint.owner)).map((endpoint) => `endpoint owner has no service: ${endpoint.owner}`);
const output = {
  schemaVersion: 1,
  sourceOfTruth: "generated-from-endpoint-registry-and-event-catalog",
  stages: JSON.parse(fs.readFileSync(path.join(root, "config/circuit/platform-circuit.json"), "utf8")).stages,
  orphanDetection: true,
  missingLinkStatus: "fail",
  generated: { endpoints: endpointEntries.length, events: catalog.events?.length ?? 0, services: services.size },
  circuits,
  orphans,
};

const outputPath = path.join(root, "config/circuit/platform-circuit.json");
if (process.argv.includes("--check")) {
  const committed = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  if (JSON.stringify(committed.circuits ?? []) !== JSON.stringify(circuits) || JSON.stringify(committed.orphans ?? []) !== JSON.stringify(orphans)) {
    console.error("Circuit registry is stale. Run: node tools/circuit-registry/build.mjs");
    process.exit(1);
  }
} else {
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
}
console.log(JSON.stringify({ output: "config/circuit/platform-circuit.json", ...output.generated, orphans }, null, 2));