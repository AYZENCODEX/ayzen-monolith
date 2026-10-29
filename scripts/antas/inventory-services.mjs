import { collectInventory, writeJson } from "./inventory-lib.mjs";

const inventory = collectInventory();
writeJson("reports/antas/baseline/services.json", {
  generatedAt: inventory.generatedAt,
  apps: inventory.apps,
  artifacts: inventory.artifacts,
  packages: inventory.packages,
  services: inventory.services,
});
console.log(JSON.stringify({ output: "reports/antas/baseline/services.json", services: inventory.counts.services }, null, 2));