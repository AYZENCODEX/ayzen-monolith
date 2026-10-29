#!/usr/bin/env node
/**
 * scripts/validate-contract-exceptions.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * AYZEN Roadmap — Phase 06 ("Contract Zero-Gap Sprint") exception-registry
 * gate.
 *
 * scripts/validate-domain-contract-coverage.mjs's committed baseline (see
 * its own header) accepts today's known findings *forever*, silently, once
 * frozen — good for catching *new* drift, but it never forces a second look
 * at an old one. Phase 06's definition of done is "zero unresolved contract
 * findings", which this repo interprets as: every current finding from
 * tools/contract-validator/domain-coverage.mjs must be either fixed, or
 * covered by an explicit, EXPIRING entry in
 * reports/contracts/contract-exceptions.json (schema:
 * schemas/contracts/contract-exception.v1.json). An exception past its
 * `expires` date no longer excuses anything -- the gate fails until a human
 * either renews it (having re-confirmed the reason still holds) or actually
 * resolves the underlying finding.
 *
 * This is a second, stricter gate alongside
 * validate-domain-contract-coverage.mjs, not a replacement for it: that
 * script still catches any new finding the moment it appears (fails
 * immediately, no exception needed); this one ensures the findings that
 * *are* accepted stay reviewed rather than aging into permanent baseline
 * noise. Both consume the same tools/contract-validator/domain-coverage.mjs
 * computation so they can never drift against each other on what "current"
 * means.
 *
 * Usage:
 *   node scripts/validate-contract-exceptions.mjs
 *     Exits 1 if any current finding has no matching, unexpired exception,
 *     or if any exception entry itself has expired. Always (re)writes
 *     reports/contracts/coverage-report.json with the full picture.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeDomainContractCoverage } from "../tools/contract-validator/domain-coverage.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const EXCEPTIONS_FILE = path.join(root, "reports/contracts/contract-exceptions.json");
const REPORT_FILE = path.join(root, "reports/contracts/coverage-report.json");

const CATEGORIES = ["ownersWithoutContract", "contractsWithoutEndpoints", "unresolvedOperations"];
const today = new Date().toISOString().slice(0, 10);

// ─── Load current findings and the exception registry ─────────────────────

const current = computeDomainContractCoverage();

if (!fs.existsSync(EXCEPTIONS_FILE)) {
  console.error(`No exception registry at ${path.relative(root, EXCEPTIONS_FILE)}.`);
  process.exit(1);
}
const { exceptions } = JSON.parse(fs.readFileSync(EXCEPTIONS_FILE, "utf8"));

for (const exception of exceptions) {
  if (!CATEGORIES.includes(exception.category)) {
    console.error(`Malformed exception entry: unknown category "${exception.category}" for key "${exception.key}".`);
    process.exit(1);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exception.expires ?? "")) {
    console.error(`Malformed exception entry: "${exception.key}" has no valid ISO "expires" date.`);
    process.exit(1);
  }
}

// key -> exception, per category, for O(1) lookup below.
const exceptionsByCategory = Object.fromEntries(CATEGORIES.map((category) => [
  category,
  new Map(exceptions.filter((e) => e.category === category).map((e) => [e.key, e])),
]));

// ─── Cross-check: every current finding needs a live exception ────────────

const unresolved = []; // current finding, no exception at all
const expired = []; // current finding, exception exists but has lapsed
const stale = []; // exception exists, but the finding it excuses no longer occurs

for (const category of CATEGORIES) {
  const findings = current[category] ?? [];
  const registered = exceptionsByCategory[category];
  for (const key of findings) {
    const exception = registered.get(key);
    if (!exception) {
      unresolved.push({ category, key });
    } else if (exception.expires < today) {
      expired.push({ category, key, expires: exception.expires, owner: exception.owner });
    }
  }
  const findingSet = new Set(findings);
  for (const [key, exception] of registered) {
    if (!findingSet.has(key)) stale.push({ category, key, expires: exception.expires });
  }
}

// ─── Report (always written, whether the gate passes or fails) ────────────

const report = {
  schemaVersion: 1,
  generatedAt: today,
  generatedBy: "scripts/validate-contract-exceptions.mjs",
  current,
  exceptionCount: exceptions.length,
  unresolved,
  expired,
  stale,
  status: unresolved.length || expired.length ? "BLOCKED" : "READY",
};
fs.writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);

// ─── Verdict ────────────────────────────────────────────────────────────

if (stale.length) {
  console.log("Stale exception(s) -- the finding they excuse no longer occurs (safe to remove from the registry):");
  for (const { category, key } of stale) console.log(`  [stale] ${category}: ${key}`);
}

if (unresolved.length) {
  console.error(`${unresolved.length} contract finding(s) with no exception registry entry:`);
  for (const { category, key } of unresolved) console.error(`  [unresolved] ${category}: ${key}`);
}
if (expired.length) {
  console.error(`${expired.length} exception(s) have expired and no longer excuse their finding:`);
  for (const { category, key, expires, owner } of expired) console.error(`  [expired ${expires}, owner: ${owner}] ${category}: ${key}`);
}
if (unresolved.length || expired.length) {
  console.error("Fix the underlying finding, or renew the exception in reports/contracts/contract-exceptions.json with a new, reviewed `expires` date.");
  console.error(`Report written to ${path.relative(root, REPORT_FILE)}.`);
  process.exit(1);
}

console.log(`Contract Zero-Gap gate passed: 0 unresolved findings, 0 expired exceptions (${exceptions.length} active exception(s) covering today's architectural non-routes).`);
console.log(`Report written to ${path.relative(root, REPORT_FILE)}.`);
