// ─────────────────────────────────────────────────────────────────────────
// tools/contract-validator/domain-coverage.mjs
//
// Shared "does every ENDPOINT_REGISTRY owner have a domain contract, and
// does every domain contract's publicOperations resolve to a real
// endpoint?" computation. Extracted out of
// scripts/validate-domain-contract-coverage.mjs (Phase 06, "Contract
// Zero-Gap Sprint") so the same logic can be consumed both by that script's
// baseline-diff gate and by scripts/validate-contract-exceptions.mjs's
// exception-registry gate, without the two drifting against each other.
// Behavior is unchanged from the original inline version -- see that
// script's header comment for the full fuzzy-matching rationale.
// ─────────────────────────────────────────────────────────────────────────
import { DOMAIN_CONTRACTS } from "../../packages/domain-boundaries/src/index.mjs";
import { ENDPOINT_REGISTRY } from "../../packages/endpoint-registry/src/index.mjs";

const OWNER_ALIASES = { "telegram-gateway": "telegram" };

const STOPWORDS = new Set(["get", "list", "create", "read", "post", "update", "delete", "manage", "issue", "run", "place", "render", "resolve", "receive"]);
const MIN_FUZZY_LEN = 4;

function operationTokens(operation) {
  const all = operation.split("-").filter(Boolean);
  const meaningful = all.filter((token) => !STOPWORDS.has(token));
  return meaningful.length ? meaningful : all;
}

function endpointWords(endpoint) {
  return `${endpoint.audit} ${endpoint.permission} ${endpoint.path}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function fuzzyMatch(token, word) {
  if (Math.min(token.length, word.length) < MIN_FUZZY_LEN) return token === word;
  return token.includes(word) || word.includes(token) || token.slice(0, MIN_FUZZY_LEN) === word.slice(0, MIN_FUZZY_LEN);
}

function endpointsOwnedBy(domainName) {
  const aliasedOwners = new Set([
    domainName,
    ...Object.entries(OWNER_ALIASES).filter(([, target]) => target === domainName).map(([owner]) => owner),
  ]);
  return ENDPOINT_REGISTRY.filter((endpoint) => aliasedOwners.has(endpoint.owner));
}

function operationResolves(operation, endpoints) {
  const tokens = operationTokens(operation);
  return endpoints.some((endpoint) => {
    const words = endpointWords(endpoint);
    return tokens.some((token) => words.some((word) => fuzzyMatch(token, word)));
  });
}

/** Recomputes the three finding categories from the current DOMAIN_CONTRACTS/ENDPOINT_REGISTRY state. */
export function computeDomainContractCoverage() {
  const contractNames = new Set(DOMAIN_CONTRACTS.map((contract) => contract.name));
  const registryOwners = new Set(ENDPOINT_REGISTRY.map((endpoint) => OWNER_ALIASES[endpoint.owner] ?? endpoint.owner));

  const ownersWithoutContract = [...registryOwners].filter((owner) => !contractNames.has(owner)).sort();

  const contractsWithoutEndpoints = DOMAIN_CONTRACTS
    .filter((contract) => endpointsOwnedBy(contract.name).length === 0)
    .map((contract) => contract.name)
    .sort();

  const unresolvedOperations = DOMAIN_CONTRACTS
    .flatMap((contract) => {
      const endpoints = endpointsOwnedBy(contract.name);
      return contract.publicOperations
        .filter((operation) => !operationResolves(operation, endpoints))
        .map((operation) => `${contract.name}:${operation}`);
    })
    .sort();

  return { ownersWithoutContract, contractsWithoutEndpoints, unresolvedOperations };
}
