import test from "node:test";
import assert from "node:assert/strict";
import { createArtifactRegistry } from "../../services/artifact-registry/src/index.mjs";

test("artifact digest verification is deterministic", () => {
  const registry = createArtifactRegistry({ artifacts: [{ id: "restore-drill", source: "backup", commit: "synthetic", buildId: "restore", digest: "sha256:restore", deploymentId: "drill" }] });
  assert.equal(registry.verify("restore-drill", "sha256:restore"), true);
  assert.equal(registry.verify("restore-drill", "sha256:wrong"), false);
});