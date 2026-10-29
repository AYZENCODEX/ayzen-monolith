import fs from "node:fs";
import { CAPABILITY_REGISTRY } from "../../packages/capabilities/src/index.mjs";
import { gate } from "../enforcement-lib.mjs";
const source = JSON.parse(fs.readFileSync("infrastructure/platform/telegram-command-registry.json", "utf8"));
const capabilities = new Set(CAPABILITY_REGISTRY.map((entry) => entry.capability));
const missing = source.commands.filter((command) => !capabilities.has(command.capability));
console.log(JSON.stringify(gate("telegram-circuit", missing.length === 0 && source.adminBot?.singleOwner === true, { total: source.commands.length, missing }), null, 2));