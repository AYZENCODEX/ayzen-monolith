import fs from "node:fs";
import path from "node:path";

export const root = process.cwd();

const SKIP_DIRECTORIES = new Set([
  ".git",
  ".cache",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".turbo",
]);

export function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

export function walk(directory, { extensions } = {}) {
  const files = [];
  if (!fs.existsSync(directory)) return files;
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(target);
      } else if (!extensions || extensions.some((extension) => entry.name.endsWith(extension))) {
        files.push(target);
      }
    }
  }
  return files.sort();
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
  } catch {
    return undefined;
  }
}

export function text(file) {
  try {
    return fs.readFileSync(path.join(root, file), "utf8");
  } catch {
    return "";
  }
}

export function exists(file) {
  return fs.existsSync(path.join(root, file));
}

function packageInventory(directory) {
  const base = path.join(root, directory);
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => {
      const manifestPath = path.join(base, entry.name, "package.json");
      const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : {};
      return {
        directory: `${directory}/${entry.name}`,
        name: manifest.name ?? entry.name,
        version: manifest.version ?? null,
        hasSourceEntrypoint: exists(`${directory}/${entry.name}/src/index.mjs`) || exists(`${directory}/${entry.name}/src/index.ts`),
        hasBuildScript: Boolean(manifest.scripts?.build),
      };
    });
}

export function collectInventory() {
  const sourceFiles = walk(root, { extensions: [".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"] });
  const manifests = [
    ...packageInventory("apps"),
    ...packageInventory("artifacts"),
    ...packageInventory("packages"),
    ...packageInventory("services"),
    ...packageInventory("scripts"),
  ];
  const routeFiles = sourceFiles.filter((file) => {
    const name = relative(file);
    return /(?:route|router|app|server|gateway)/i.test(name);
  });
  const routePattern = /\b(?:app|router)\.(?:get|post|put|patch|delete|options|head|use)\s*\(/g;
  let routeDeclarations = 0;
  for (const file of sourceFiles) routeDeclarations += (fs.readFileSync(file, "utf8").match(routePattern) ?? []).length;

  const envNames = new Set();
  const envPattern = /process\.env\.([A-Z][A-Z0-9_]*)/g;
  for (const file of sourceFiles) {
    for (const match of fs.readFileSync(file, "utf8").matchAll(envPattern)) envNames.add(match[1]);
  }
  for (const match of text(".env.example").matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)) envNames.add(match[1]);

  const eventSource = text("packages/events/src/index.mjs");
  const eventTypes = [...eventSource.matchAll(/"([a-z][a-z0-9_.-]+)"[,)]/g)].map((match) => match[1]);
  const migrationFiles = walk(path.join(root, "migrations"), { extensions: [".sql"] }).map(relative);
  const workflowFiles = walk(path.join(root, ".github/workflows"), { extensions: [".yml", ".yaml"] }).map(relative);
  const dockerFiles = walk(root, { extensions: ["Dockerfile", ".dockerfile"] }).map(relative);
  const packageJson = readJson("package.json") ?? {};
  const dependencyNames = Object.keys({
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.devDependencies ?? {}),
  }).sort();

  return {
    generatedBy: "scripts/antas/inventory-repository.mjs",
    generatedAt: new Date().toISOString(),
    repository: {
      root: path.basename(root),
      packageManager: packageJson.packageManager ?? null,
      nodeVersion: text(".nvmrc").trim() || null,
    },
    counts: {
      sourceFiles: sourceFiles.length,
      apps: packageInventory("apps").length,
      artifacts: packageInventory("artifacts").length,
      packages: packageInventory("packages").length,
      services: packageInventory("services").length,
      routeFiles: routeFiles.length,
      routeDeclarations,
      eventTypes: new Set(eventTypes).size,
      migrations: migrationFiles.length,
      workflows: workflowFiles.length,
      dockerFiles: dockerFiles.length,
      dependencies: dependencyNames.length,
    },
    apps: packageInventory("apps"),
    artifacts: packageInventory("artifacts"),
    packages: packageInventory("packages"),
    services: packageInventory("services"),
    routes: {
      files: routeFiles.map(relative),
      declarations: routeDeclarations,
    },
    eventTypes: [...new Set(eventTypes)].sort(),
    migrations: migrationFiles,
    workflows: workflowFiles,
    dockerFiles,
    environmentVariables: [...envNames].sort(),
    dependencies: dependencyNames,
    featureFlags: [...new Set(
      sourceFiles.flatMap((file) => [...fs.readFileSync(file, "utf8").matchAll(/(?:FEATURE|FLAG|ENABLE)_[A-Z0-9_]+/g)].map((match) => match[0])),
    )].sort(),
  };
}

export function ensureDirectory(directory) {
  fs.mkdirSync(path.join(root, directory), { recursive: true });
}

export function writeJson(file, value) {
  ensureDirectory(path.dirname(file));
  fs.writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);
}

export function writeText(file, value) {
  ensureDirectory(path.dirname(file));
  fs.writeFileSync(path.join(root, file), value.endsWith("\n") ? value : `${value}\n`);
}