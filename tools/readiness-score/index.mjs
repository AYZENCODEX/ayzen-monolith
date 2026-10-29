#!/usr/bin/env node

export const HARD_BLOCKERS = Object.freeze([
  "critical-security-finding",
  "unaccepted-high-finding",
  "build-failure",
  "incomplete-circuit",
  "unexplained-ui-gap",
  "undeclared-cross-app-edge",
  "authorization-gap",
  "schema-drift",
  "missing-e2e-evidence",
  "missing-observability",
  "missing-restore-evidence",
  "missing-provenance",
  "rollback-failure",
  "performance-slo-failure",
  "silent-validator-skip",
]);

export function calculateReadinessScore(categories = [], blockers = []) {
  const normalizedCategories = categories.map((category) => ({
    id: category.id,
    weight: Number(category.weight) || 0,
    status: category.status === "PASS" ? "PASS" : "FAIL",
  }));
  const weight = normalizedCategories.reduce((sum, category) => sum + category.weight, 0);
  const passed = normalizedCategories.reduce((sum, category) => sum + (category.status === "PASS" ? category.weight : 0), 0);
  const activeBlockers = blockers.filter((blocker) => HARD_BLOCKERS.includes(blocker.type ?? blocker));
  return Object.freeze({
    score: weight ? Math.round((passed / weight) * 100) : 0,
    status: activeBlockers.length === 0 && normalizedCategories.every((category) => category.status === "PASS") ? "PASS" : "BLOCKED",
    categories: normalizedCategories,
    blockers: activeBlockers,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(calculateReadinessScore([
    { id: "architecture", weight: 20, status: "PASS" },
    { id: "security", weight: 20, status: "PASS" },
    { id: "operations", weight: 20, status: "PASS" },
    { id: "delivery", weight: 20, status: "PASS" },
    { id: "journeys", weight: 20, status: "PASS" },
  ]), null, 2));
}