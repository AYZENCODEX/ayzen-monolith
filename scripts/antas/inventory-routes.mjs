import { collectInventory, writeJson } from "./inventory-lib.mjs";

const inventory = collectInventory();
writeJson("reports/antas/baseline/routes.json", {
  generatedAt: inventory.generatedAt,
  ...inventory.routes,
});
console.log(JSON.stringify({ output: "reports/antas/baseline/routes.json", ...inventory.routes }, null, 2));