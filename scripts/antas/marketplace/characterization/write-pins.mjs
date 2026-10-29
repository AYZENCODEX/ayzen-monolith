#!/usr/bin/env node
// Rewrites pins.json from the current tree. Run only for an intended, reviewed change (a migration that moves code, or a
// listed behavior change) and read the diff: every changed line must be explained in the phase evidence.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectFacts } from "./extract.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
const facts = collectFacts();
fs.writeFileSync(path.join(here, "pins.json"), JSON.stringify({ schemaVersion: 1, phase: "MKT-01a", note: "Pinned static facts about the current Marketplace routes, defects included (MKT-ISSUE-6, MKT-ISSUE-7). Not proof of correctness.", ...facts }, null, 1) + "\n");
console.log(`pins written: ${Object.keys(facts.files).length} files, ${Object.keys(facts.routes).length} routes with writes or transactions, ${facts.realFloatColumns.length} REAL columns`);
