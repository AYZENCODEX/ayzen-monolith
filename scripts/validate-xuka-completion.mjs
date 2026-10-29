import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getXukaImplementationSnapshot, listXukaPhases } from "../packages/xuka/src/index.mjs";

const root = process.cwd();
const roadmapPath = path.join(root, "attached_assets/AYZEN_XUKA_Renumbered_Remaining_Implementation_Roadmap_(1)_1790165342457.docx");
const fallbackRoadmap = fs.readdirSync(path.join(root, "attached_assets"), { withFileTypes: true })
  .filter((entry) => entry.isFile() && /^AYZEN_.*roadmap.*\.docx$/i.test(entry.name))
  .map((entry) => path.join(root, "attached_assets", entry.name))[0];
const evidencePath = fs.existsSync(roadmapPath) ? roadmapPath : fallbackRoadmap;
if (!evidencePath) {
  console.error(`XUKA completion evidence is unavailable: ${path.relative(root, roadmapPath)}`);
  process.exit(1);
}
const roadmap = fs.readFileSync(evidencePath);
assert.ok(roadmap.length > 0, "attached XUKA roadmap is empty");

const phases = listXukaPhases();
assert.equal(phases.length, 156, "XUKA remaining roadmap has 156 registered phases");
assert.deepEqual(phases.map((phase) => phase.phase), Array.from({ length: 156 }, (_, index) => index + 1));
assert.ok(phases.every((phase) => phase.status === "implemented"), "one or more XUKA phases is not registered");

const snapshot = getXukaImplementationSnapshot();
for (const [area, evidence] of Object.entries(snapshot.evidence)) {
  assert.ok(evidence && typeof evidence === "object", `missing XUKA evidence area: ${area}`);
  assert.ok(Object.values(evidence).every(Boolean), `incomplete XUKA evidence area: ${area}`);
}
assert.equal(snapshot.evidence.connectivity.crossChannel, true);
assert.equal(snapshot.evidence.connectivity.crossApp, true);
assert.equal(snapshot.evidence.connectivity.crossBot, true);
console.log(`XUKA completion passed (${phases.length} phases, ${Object.keys(snapshot.evidence).length} evidence areas)`);