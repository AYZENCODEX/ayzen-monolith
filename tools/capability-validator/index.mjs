import fs from "node:fs";
import { CAPABILITY_REGISTRY } from "../../packages/capabilities/src/index.mjs";
import { gate } from "../enforcement-lib.mjs";

const missing = CAPABILITY_REGISTRY.filter((entry) => !entry.permission || !entry.auditEvent || !entry.domain);
const admin = CAPABILITY_REGISTRY.filter((entry) => entry.domain === "admin");
const result = gate("capability-100-percent", missing.length === 0 && admin.length > 0, { total: CAPABILITY_REGISTRY.length, missing: missing.map((entry) => entry.capability), admin: admin.length });
if (result.passed) console.log(JSON.stringify(result, null, 2));