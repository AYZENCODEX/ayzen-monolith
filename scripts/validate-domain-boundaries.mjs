import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const failures = [];
const deploymentCatalog = JSON.parse(fs.readFileSync(path.join(root, "infrastructure/deployment/service-catalog.json"), "utf8"));
const deployableDirectories = new Set((deploymentCatalog.deployables ?? [])
  .map((item) => item.source.replace(/^services\//, ""))
  .filter((item) => item !== "services"));
const services = fs.readdirSync(path.join(root, "services"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
  .map((entry) => entry.name);

for (const service of services) {
  const entry = path.join(root, "services", service, "src", "index.mjs");
  if (!fs.existsSync(entry)) failures.push(`${service}: missing public service entrypoint`);
  if (fs.existsSync(path.join(root, "services", service, "src", "repository.mjs"))) {
    failures.push(`${service}: repositories must remain private to the owning service`);
  }
  const packageJson = path.join(root, "services", service, "package.json");
  const packageText = fs.existsSync(packageJson) ? fs.readFileSync(packageJson, "utf8") : "";
  if (deployableDirectories.has(service) && !packageText.includes("@ayzen/service-runtime")) failures.push(`${service}: missing service runtime dependency`);
}

const forbiddenCrossDomainPatterns = [
  /from\s+["'][^"']*services\/[^"']+\/src\/(?:repository|private)/,
  /@workspace\/db.*(?:services\/|@ayzen\/(?:finance|vault|mail|workflow|notification))/,
];
for (const directory of ["apps", "packages", "services"]) {
  const base = path.join(root, directory);
  if (!fs.existsSync(base)) continue;
  const stack = [base];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") stack.push(target);
      } else if (/\.(m?js|ts)$/.test(entry.name)) {
        const source = fs.readFileSync(target, "utf8");
        for (const pattern of forbiddenCrossDomainPatterns) {
          if (pattern.test(source)) failures.push(`${path.relative(root, target)}: forbidden private/database cross-domain import`);
        }
      }
    }
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`Domain boundary validation passed (${services.length} services)`);