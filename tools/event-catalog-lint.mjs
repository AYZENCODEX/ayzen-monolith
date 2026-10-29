import fs from "node:fs";
import path from "node:path";
import { EVENT_TYPES, listEventDefinitions } from "../packages/events/src/index.mjs";

const catalog = JSON.parse(fs.readFileSync("infra/event-catalog/catalog.json", "utf8"));
const entries = new Map((catalog.events ?? []).map((entry) => [entry.type, entry]));
const failures = [];
const producers = new Set();
const sourceRoots = ["apps", "services", "artifacts", "packages"];
function visit(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (/\.(mjs|ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".test.mjs")) {
      const source = fs.readFileSync(file, "utf8");
      if (!source.includes("createHttpEventPublisher") && !source.includes("emittedEvents") && !source.includes("consumedEvents")) continue;
      for (const type of EVENT_TYPES) if (source.includes(`"${type}"`) || source.includes(`'${type}'`)) producers.add(type);
    }
  }
}
for (const root of sourceRoots) visit(root);
for (const type of EVENT_TYPES) {
  const entry = entries.get(type);
  if (!entry) failures.push(`event is missing from catalog: ${type}`);
  else if (!Array.isArray(entry.consumers) || entry.consumers.length === 0) failures.push(`event has no consumers: ${type}`);
}
for (const entry of catalog.events ?? []) {
  if (!EVENT_TYPES.includes(entry.type)) failures.push(`catalog contains unregistered event: ${entry.type}`);
  const definition = listEventDefinitions().find((candidate) => candidate.type === entry.type);
  if (definition && definition.version !== entry.version) failures.push(`catalog version drift: ${entry.type}`);
}
for (const type of producers) {
  if (!EVENT_TYPES.includes(type)) failures.push(`source references unregistered event: ${type}`);
  if (!entries.has(type)) failures.push(`source event is missing from catalog: ${type}`);
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`Event catalog passed (${entries.size} events, every event has a declared consumer)`);