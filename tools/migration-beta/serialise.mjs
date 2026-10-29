#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const sourceDir = path.join(root, "migrations");
const targetDir = path.join(root, "migrations/beta/transferred");
const registryPath = path.join(root, "migrations/beta/serial-registry.json");
const sourceFiles = fs.readdirSync(sourceDir)
  .filter((name) => /^\d{3}_[a-z0-9][a-z0-9_-]+\.sql$/.test(name))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

const APP_RULES = [
  ["identity", /passkey|otp|oidc|rbac|relationship|policy|authorization|session|api_key/i],
  ["finance", /finance|wallet|credit|payment|receipt|invoice|accounting|depreciation|lending|investment/i],
  ["mail", /mail|email|mailbox|message|sending|bounce|complaint|spam|snooze|delivery|template/i],
  ["vault", /vault|snapshot|backup|encryption|emergency|cloud_connection/i],
  ["notification", /notification/i],
  ["workflow", /workflow|scheduler|scheduled_job|event_bus|eventbus|service_state/i],
  ["central", /project|organization|task|category|dev_nav/i],
];

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function ownerFor(file) {
  const match = APP_RULES.find(([, pattern]) => pattern.test(file));
  return match?.[0] ?? "platform";
}

function buildEntries() {
  const counters = new Map();
  return sourceFiles.map((source, index) => {
    const app = ownerFor(source);
    const appSerial = (counters.get(app) ?? 0) + 1;
    counters.set(app, appSerial);
    const projectSerial = index + 1;
    const stem = source.slice(0, -4);
    const targetName = `P${String(projectSerial).padStart(3, "0")}_A${String(appSerial).padStart(3, "0")}_${app}__${stem}.sql`;
    return {
      projectSerial,
      appSerial,
      app,
      source: path.posix.join("migrations", source),
      target: path.posix.join("migrations/beta/transferred", app, targetName),
      sourceName: source,
      targetName,
      checksum: sha256(path.join(sourceDir, source)),
      status: "transferred",
    };
  });
}

function writeTransfers(entries) {
  for (const entry of entries) {
    const destination = path.join(root, entry.target);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, entry.source), destination);
    if (sha256(destination) !== entry.checksum) throw new Error(`Checksum mismatch after transfer: ${entry.source}`);
  }
}

const entries = buildEntries();
if (process.argv.includes("--write")) writeTransfers(entries);
const output = {
  schemaVersion: 1,
  naming: "P{projectSerial}_A{appSerial}_{app}__{legacyStem}.sql",
  sourceOfTruth: "migrations/*.sql",
  transferredRoot: "migrations/beta/transferred",
  count: entries.length,
  entries,
};
fs.writeFileSync(registryPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`${process.argv.includes("--write") ? "Transferred" : "Planned"} ${entries.length} SQL migrations with unique project and app serials.`);