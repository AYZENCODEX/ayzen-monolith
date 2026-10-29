import assert from "node:assert/strict";
import test from "node:test";
import { generateProjectReceiptToken, projectReceiptUrl } from "./receipt-token";

// PRJ-04: possession of the token is the authorization, so its shape matters.

test("tokens are 20 random bytes, base64url, and not repeated", () => {
  const a = generateProjectReceiptToken();
  const b = generateProjectReceiptToken();
  assert.match(a, /^[A-Za-z0-9_-]{27}$/);
  assert.notEqual(a, b);
});

test("receipt URL uses APP_URL with the documented fallback", () => {
  const saved = process.env.APP_URL;
  try {
    delete process.env.APP_URL;
    assert.equal(projectReceiptUrl("abc"), "https://ayzen.replit.app/receipt/project/abc");
    process.env.APP_URL = "https://example.test";
    assert.equal(projectReceiptUrl("abc"), "https://example.test/receipt/project/abc");
  } finally {
    if (saved === undefined) delete process.env.APP_URL; else process.env.APP_URL = saved;
  }
});
