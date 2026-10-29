import test from "node:test";
import assert from "node:assert/strict";
import { createResiliencePolicy } from "../src/index.mjs";

test("creates bounded failure policy", () => {
  assert.equal(createResiliencePolicy({ timeoutMs: 5000 }).fallback, "explicit-only");
  assert.throws(() => createResiliencePolicy({ timeoutMs: 0 }), /Invalid/);
});