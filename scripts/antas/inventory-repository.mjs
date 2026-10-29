import { collectInventory, writeJson, writeText } from "./inventory-lib.mjs";

const inventory = collectInventory();
writeJson("reports/antas/baseline/repository-inventory.json", inventory);
writeText(
  "docs/antas/baseline/repository-inventory.md",
  [
    "# Repository inventory",
    "",
    `Generated: ${inventory.generatedAt}`,
    "",
    "## Counts",
    "",
    ...Object.entries(inventory.counts).map(([name, value]) => `- ${name}: ${value}`),
    "",
    "## Applications and services",
    "",
    ...[...inventory.apps, ...inventory.artifacts, ...inventory.services].map(
      (item) => `- ${item.directory} — ${item.name}${item.hasSourceEntrypoint ? " (entrypoint)" : ""}`,
    ),
    "",
    "## External/runtime boundary",
    "",
    "- Environment variable names are inventoried without values.",
    "- Provider-backed behavior, staging results, and production traffic remain explicit runtime gates.",
  ].join("\n"),
);
console.log(JSON.stringify({ output: "reports/antas/baseline/repository-inventory.json", counts: inventory.counts }, null, 2));