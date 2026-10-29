import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const service = process.argv.find((arg) => arg.startsWith("--service="))?.slice("--service=".length);
const output = process.argv.find((arg) => arg.startsWith("--output="))?.slice("--output=".length)
  ?? "artifacts/release/release-manifest.json";
const catalog = JSON.parse(fs.readFileSync("infrastructure/deployment/service-catalog.json", "utf8"));
const deployable = catalog.deployables.find((item) => item.name === service);
if (!deployable) {
  console.error(`Unknown deployable: ${service ?? "(missing --service)"}`);
  process.exit(1);
}

const gitCommit = process.env.GITHUB_SHA ?? process.env.GIT_COMMIT ?? "local";
const releaseId = process.env.RELEASE_ID ?? process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
const imageDigest = process.env.IMAGE_DIGEST;
if (!imageDigest && process.env.REQUIRE_IMAGE_DIGEST === "true") {
  console.error("IMAGE_DIGEST is required for an immutable release manifest");
  process.exit(1);
}
const manifest = {
  schemaVersion: 1,
  releaseId,
  gitCommit,
  service: deployable.name,
  package: deployable.package,
  owner: deployable.owner,
  image: {
    repository: process.env.IMAGE_REPOSITORY ?? catalog.defaultImage,
    tag: `sha-${gitCommit}`,
    ...(imageDigest ? { digest: imageDigest } : {}),
  },
  runtime: {
    port: deployable.port,
    health: deployable.health,
    readiness: deployable.readiness,
    rollback: deployable.rollback,
  },
  generatedAt: new Date().toISOString(),
};
manifest.manifestHash = crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ output, releaseId, service: deployable.name, manifestHash: manifest.manifestHash }, null, 2));