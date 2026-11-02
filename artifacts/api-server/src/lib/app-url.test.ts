import assert from "node:assert/strict";
import test from "node:test";
import { getAppUrl } from "./app-url";

test("defaults to the canonical origin and normalizes APP_URL", () => {
  const saved = process.env.APP_URL;
  try {
    delete process.env.APP_URL;
    assert.equal(getAppUrl(), "https://ayzen.tech");
    process.env.APP_URL = "  ";
    assert.equal(getAppUrl(), "https://ayzen.tech");
    process.env.APP_URL = " https://example.test/// ";
    assert.equal(getAppUrl(), "https://example.test");
  } finally {
    if (saved === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = saved;
  }
});
