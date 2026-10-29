import { collectInventory, writeJson } from "./inventory-lib.mjs";

const inventory = collectInventory();
writeJson("reports/antas/baseline/environment.json", {
  generatedAt: inventory.generatedAt,
  names: inventory.environmentVariables,
  valuesIncluded: false,
});
console.log(JSON.stringify({ output: "reports/antas/baseline/environment.json", names: inventory.environmentVariables.length, valuesIncluded: false }, null, 2));