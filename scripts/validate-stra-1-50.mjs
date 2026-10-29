import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  STRA_STAGES,
  createStraGraphRegistry,
  createStraHealthScorecard,
} from "../packages/architecture/src/index.mjs";

const root = process.cwd();
const failures = [];
const expectedPhases = Array.from({ length: 50 }, (_, index) => index + 1);

function readJson(relative) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
  } catch (error) {
    failures.push(`${relative}: ${error.message}`);
    return {};
  }
}

function exists(relative, label = "evidence") {
  if (!fs.existsSync(path.join(root, relative))) failures.push(`Missing ${label}: ${relative}`);
}

function assertSource(relative, markers) {
  const source = fs.readFileSync(path.join(root, relative), "utf8");
  for (const marker of markers) if (!source.includes(marker)) failures.push(`${relative}: missing ${marker}`);
}

const roadmap = readJson("infrastructure/platform/roadmap-stra-1-50.json");
const architecture = readJson("infrastructure/platform/stra-architecture.json");
const domain = readJson("infrastructure/platform/stra-domain-fabric.json");
const migration = readJson("infrastructure/platform/stra-migration-beta.json");
const telegram = readJson("infrastructure/platform/stra-telegram-command-os.json");
const cloud = readJson("infrastructure/platform/stra-cloud-fabric.json");
const commands = readJson("infrastructure/platform/telegram-command-registry.json");
const botContract = readJson("infrastructure/platform/telegram-bot-contract.json");

if (roadmap.phaseRange?.join(",") !== "1,50") failures.push("STRA roadmap must cover phases 1 through 50");
if (roadmap.phases?.length !== 50) failures.push("STRA roadmap must contain exactly 50 phases");
if (roadmap.phases?.some((phase, index) => phase.phase !== expectedPhases[index])) {
  failures.push("STRA phases must contain every phase 1–50 exactly once and in order");
}
if (roadmap.status !== "implemented-and-governed") failures.push("STRA roadmap status is not implemented-and-governed");
if (roadmap.implementationContract?.order?.length !== 7) failures.push("STRA implementation order is incomplete");
if (roadmap.implementationContract?.verification?.length !== 5) failures.push("STRA verification contract is incomplete");

const workstreams = new Map((roadmap.workstreams ?? []).map((workstream) => [workstream.id, workstream]));
if (workstreams.size !== 5) failures.push("STRA roadmap must define five workstreams");
for (const workstream of workstreams.values()) {
  const [start, end] = workstream.phases ?? [];
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) {
    failures.push(`${workstream.id}: invalid phase range`);
  }
  for (const evidence of workstream.evidence ?? []) exists(evidence, `${workstream.id} evidence`);
}
for (const phase of roadmap.phases ?? []) {
  if (!phase.owner || phase.status !== "implemented") failures.push(`STRA phase ${phase.phase} requires an owner and implemented status`);
  const workstream = workstreams.get(phase.workstream);
  if (!workstream || phase.phase < workstream.phases[0] || phase.phase > workstream.phases[1]) {
    failures.push(`STRA phase ${phase.phase} is outside its workstream range`);
  }
}

if (architecture.stageOrder?.join("|") !== STRA_STAGES.join("|")) failures.push("STRA stage order does not match the executable engine");
if (architecture.engine !== "packages/architecture/src/index.mjs") failures.push("STRA architecture does not identify its executable engine");
for (const relative of [
  "infrastructure/platform/stra-architecture.json",
  "infrastructure/platform/stra-domain-fabric.json",
  "infrastructure/platform/stra-migration-beta.json",
  "infrastructure/platform/stra-telegram-command-os.json",
  "infrastructure/platform/stra-cloud-fabric.json",
  "scripts/validate-stra-1-50.mjs",
  "packages/architecture/src/index.mjs",
  "packages/architecture/test/index.test.mjs",
]) exists(relative);

const graph = createStraGraphRegistry(architecture.registry);
for (const circuit of graph.listCircuits()) {
  const trace = graph.traceLocalCircuit(circuit.id);
  if (trace.status !== "COMPLETE") failures.push(`Incomplete STRA local circuit: ${circuit.id}`);
  if (trace.nodes.length !== STRA_STAGES.length) failures.push(`${circuit.id}: does not cover every STRA stage`);
}
if (graph.dependencyCycles().length !== 0) failures.push("STRA graph contains a dependency cycle");
const expectedPath = graph.traceLocalCircuit(graph.listCircuits()[0].id).nodes.map((node) => node.id);
if (!graph.compareRuntimePath(graph.listCircuits()[0].id, expectedPath).matches) failures.push("STRA runtime path comparison failed");
if (graph.findImpacted(["stra-db"]).length < 4) failures.push("STRA dependency impact traversal is incomplete");
const scorecard = createStraHealthScorecard(graph);
if (scorecard.status !== "healthy" || scorecard.circuitScore !== 100) failures.push("STRA graph health scorecard is not healthy");

if (domain.routing?.undeclaredTargets !== "deny") failures.push("STRA domain routing is not default-deny");
if (domain.routing?.environmentIsolation !== "staging-cannot-target-production") failures.push("STRA environment routing isolation is missing");
if (migration.states?.length !== 7 || migration.gates?.length !== 5) failures.push("STRA migration state or gate contract is incomplete");
if (migration.controls?.locking !== "database-appropriate-lock-or-lease") failures.push("STRA migration locking policy is missing");
if (telegram.coverageRule !== "one-supported-sub-feature-to-one-command") failures.push("STRA Telegram coverage rule is missing");
if ((commands.commands ?? []).length < 70 || (botContract.bots ?? []).length < 9) failures.push("STRA Telegram command catalog is incomplete");
if (cloud.resilience?.scaling !== "measured-queue-age-and-utilization") failures.push("STRA cloud scaling policy is missing");
if (cloud.security?.environmentIsolation !== "staging-before-production") failures.push("STRA cloud environment isolation is missing");

const migrationResult = spawnSync(process.execPath, ["scripts/validate-migration-beta.mjs"], { cwd: root, encoding: "utf8" });
if (migrationResult.status !== 0) failures.push(`Migration beta validator failed: ${migrationResult.stderr || migrationResult.stdout}`);
for (const relative of ["packages/architecture/src/index.mjs", "scripts/validate-stra-1-50.mjs", "packages/architecture/test/index.test.mjs"]) {
  const syntax = spawnSync(process.execPath, ["--check", relative], { cwd: root, encoding: "utf8" });
  if (syntax.status !== 0) failures.push(`${relative}: syntax check failed: ${syntax.stderr}`);
}
assertSource("packages/architecture/src/index.mjs", [
  "createStraGraphRegistry",
  "traceLocalCircuit",
  "compareRuntimePath",
  "createStraHealthScorecard",
]);

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`STRA phases 1–50 validation passed (50 phases, ${graph.listCircuits().length} local circuits, ${commands.commands.length} Telegram commands)`);