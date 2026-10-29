import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { validateCrossAppMatrix, createAppAccessGateway } from "../../services/app-access-gateway/src/index.mjs";

const matrix = JSON.parse(fs.readFileSync("config/cross-app/matrix.json", "utf8")).edges;

test("cross-app matrix is explicit and default deny", () => {
  assert.equal(validateCrossAppMatrix(matrix).valid, true);
  const gateway = createAppAccessGateway({ matrix });
  assert.equal(gateway.authorize({ from: "unknown", to: "finance", action: "read" }).decision, "deny");
  assert.equal(gateway.authorize({ from: "ryft", to: "finance", action: "delete" }).decision, "deny");
});