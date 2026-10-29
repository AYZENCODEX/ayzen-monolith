#!/usr/bin/env node
/**
 * scripts/validate-domain-contract-coverage.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * AYZEN Roadmap — Track F, Phase F4 ("Domain-boundary contract cross-check").
 *
 * `packages/domain-boundaries` declares each domain's `publicOperations` —
 * but until now nothing checked that against the Phase F1 generated
 * registry. This closes that gap in both directions:
 *
 *   1. Every ENDPOINT_REGISTRY entry's `owner` must have a matching domain
 *      contract (catches an undeclared/mis-owned route).
 *   2. Every domain contract's `publicOperations` should resolve to at
 *      least one registered endpoint owned by that domain (catches a
 *      declared-but-unbuilt operation).
 *
 * Operation → endpoint resolution is necessarily fuzzy (a domain contract's
 * "authenticate" and the registry's generated audit event
 * "identity.auth.login.write" are the same real thing, spelled
 * differently) — see `fuzzyMatch` below. Fuzzy matching means this
 * validator can produce a real, defensible finding without a corresponding
 * code fix being obvious or even correct (e.g. Telegram's "resolve-command"
 * genuinely has no HTTP endpoint by design — Track E resolves it inside the
 * command-tree parser, not as a REST route). So, same pattern as Track H's
 * ownership-gate baseline: today's known findings are frozen in
 * `scripts/domain-contract-coverage-baseline.json`. This gate fails only on
 * a *new* finding beyond that baseline, not on the existing ones — each of
 * which needs a human decision (fix the contract's vocabulary, fix the
 * route, or accept it as an architectural non-route operation), not a
 * silent pass.
 *
 * Usage:
 *   node scripts/validate-domain-contract-coverage.mjs
 *     Compares current findings against the committed baseline. Exits 1 and
 *     prints the new drift if anything beyond the baseline appears.
 *   node scripts/validate-domain-contract-coverage.mjs --update-baseline
 *     Regenerates the baseline file from current findings (run this after
 *     deliberately fixing or accepting a finding, same as Track H's
 *     `--update-baseline`).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeDomainContractCoverage } from "../tools/contract-validator/domain-coverage.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_FILE = path.join(__dirname, "domain-contract-coverage-baseline.json");

// ─── Compute current findings ───────────────────────────────────────────

const current = computeDomainContractCoverage();
const { ownersWithoutContract, contractsWithoutEndpoints, unresolvedOperations } = current;

// ─── --update-baseline mode ─────────────────────────────────────────────

if (process.argv.includes("--update-baseline")) {
  fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`Baseline updated: ${ownersWithoutContract.length} unmapped owner(s), ${contractsWithoutEndpoints.length} endpoint-less contract(s), ${unresolvedOperations.length} unresolved operation(s).`);
  process.exit(0);
}

// ─── Compare against the committed baseline ─────────────────────────────

if (!fs.existsSync(BASELINE_FILE)) {
  console.error(`No baseline file at ${path.relative(process.cwd(), BASELINE_FILE)}.`);
  console.error("Run with --update-baseline to generate one from current findings, review it, and commit it.");
  process.exit(1);
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));

function newEntries(currentList, baselineList) {
  const known = new Set(baselineList);
  return currentList.filter((entry) => !known.has(entry));
}

function fixedEntries(currentList, baselineList) {
  const present = new Set(currentList);
  return baselineList.filter((entry) => !present.has(entry));
}

const drift = {
  ownersWithoutContract: newEntries(current.ownersWithoutContract, baseline.ownersWithoutContract ?? []),
  contractsWithoutEndpoints: newEntries(current.contractsWithoutEndpoints, baseline.contractsWithoutEndpoints ?? []),
  unresolvedOperations: newEntries(current.unresolvedOperations, baseline.unresolvedOperations ?? []),
};
const improvements = {
  ownersWithoutContract: fixedEntries(current.ownersWithoutContract, baseline.ownersWithoutContract ?? []),
  contractsWithoutEndpoints: fixedEntries(current.contractsWithoutEndpoints, baseline.contractsWithoutEndpoints ?? []),
  unresolvedOperations: fixedEntries(current.unresolvedOperations, baseline.unresolvedOperations ?? []),
};

const hasNewDrift = drift.ownersWithoutContract.length || drift.contractsWithoutEndpoints.length || drift.unresolvedOperations.length;
const hasImprovements = improvements.ownersWithoutContract.length || improvements.contractsWithoutEndpoints.length || improvements.unresolvedOperations.length;

console.log(`Domain-contract coverage: ${current.ownersWithoutContract.length} unmapped registry owner(s), ${current.contractsWithoutEndpoints.length} endpoint-less contract(s), ${current.unresolvedOperations.length} unresolved operation(s) — all within baseline unless noted below.`);

if (hasImprovements) {
  console.log("Baseline entries no longer present (run --update-baseline to shrink the file once these are deliberate):");
  for (const [category, entries] of Object.entries(improvements)) {
    for (const entry of entries) console.log(`  [fixed] ${category}: ${entry}`);
  }
}

if (hasNewDrift) {
  console.error("New domain-contract coverage drift beyond the committed baseline:");
  for (const [category, entries] of Object.entries(drift)) {
    for (const entry of entries) console.error(`  [new] ${category}: ${entry}`);
  }
  console.error("Either fix the route/contract, or if this is a deliberate, reviewed addition, re-run with --update-baseline.");
  process.exit(1);
}

console.log("No new domain-contract coverage drift beyond the committed baseline.");
