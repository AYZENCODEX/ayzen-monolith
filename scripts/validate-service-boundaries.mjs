import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const serviceRoot = path.join(root, "services");
const ignored = new Set(["_service-template"]);
const requiredProbes = ["/health", "/live", "/ready"];
const failures = [];
const deploymentCatalog = JSON.parse(fs.readFileSync(path.join(root, "infrastructure/deployment/service-catalog.json"), "utf8"));
const deployableDirectories = new Set((deploymentCatalog.deployables ?? []).map((item) => item.source.replace(/^services\//, "")));

for (const name of fs.readdirSync(serviceRoot, { withFileTypes: true })) {
  if (!name.isDirectory() || ignored.has(name.name)) continue;
  const entry = path.join(serviceRoot, name.name, "src", "index.mjs");
  if (!fs.existsSync(entry)) {
    failures.push(`${name.name}: missing src/index.mjs`);
    continue;
  }
  const source = fs.readFileSync(entry, "utf8");
  if (!deployableDirectories.has(name.name)) continue;
  for (const probe of requiredProbes) {
    if (!source.includes("createServiceServer")) {
      failures.push(`${name.name}: does not use service runtime`);
      break;
    }
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("Service boundary validation passed");