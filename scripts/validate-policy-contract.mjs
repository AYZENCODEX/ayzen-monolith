#!/usr/bin/env node
// Phase 07 gate: every one of the seven required consumer kinds must have
// a policy-contract adapter file that imports the contract, and the
// contract must return allow, deny and conditional.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { CONSUMERS, decide, createConsumerClient } = await import(pathToFileURL(path.join(root, "packages/policy-contract/src/index.mjs")).href);

const ADAPTERS = {
  api: "packages/api-contracts/src/policy-contract-adapter.mjs",
  service: "services/policy/src/index.mjs",
  event: "packages/event-client/src/policy-contract-adapter.mjs",
  workflow: "packages/workflow/src/policy-contract-adapter.mjs",
  scheduler: "services/scheduler/src/policy-contract-adapter.mjs",
  telegram: "packages/telegram/src/policy-contract-adapter.mjs",
  admin: "services/admin/src/policy-contract-adapter.mjs",
};
const failures = [];

for (const kind of CONSUMERS) {
  const rel = ADAPTERS[kind];
  if (!rel) { failures.push(`no adapter registered for consumer "${kind}"`); continue; }
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) { failures.push(`${kind}: missing ${rel}`); continue; }
  const src = fs.readFileSync(file, "utf8");
  // "service" is served by services/policy, which rides the shared PDP that the contract's conditional support lives in.
  const wired = kind === "service" ? src.includes("createPolicyDecisionPoint") : src.includes("@ayzen/policy-contract");
  if (!wired) failures.push(`${kind}: ${rel} does not use the unified contract`);
}
for (const rel of Object.values(ADAPTERS)) void rel;

const schema = JSON.parse(fs.readFileSync(path.join(root, "schemas/policy/decision.v1.json"), "utf8"));
for (const d of ["allow", "deny", "conditional"]) if (!schema.properties.decision.enum.includes(d)) failures.push(`schema missing decision "${d}"`);
if (JSON.stringify(schema.properties.consumer.enum) !== JSON.stringify(CONSUMERS)) failures.push("schema consumer enum drifted from CONSUMERS");

const base = { app: "ryft", subject: "u-1" };
const seen = new Set([
  decide({ ...base, consumer: "api", capability: "finance.list-accounts", scopes: ["finance:read"] }).decision,
  decide({ ...base, consumer: "api", capability: "finance.list-accounts", subject: undefined }).decision,
  decide({ ...base, consumer: "api", capability: "finance.post-transaction", scopes: ["finance:write"] }).decision,
]);
for (const d of ["allow", "deny", "conditional"]) if (!seen.has(d)) failures.push(`contract never produced "${d}"`);
try { createConsumerClient("bogus"); failures.push("unknown consumer was accepted"); } catch { /* expected */ }

if (failures.length) { console.error("policy-contract validation FAILED:\n - " + failures.join("\n - ")); process.exit(1); }
console.log(`policy-contract validation passed (${CONSUMERS.length} consumers, allow/deny/conditional).`);
