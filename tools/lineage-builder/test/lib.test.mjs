import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractRouteCalls, extractLocalImports, buildRouteIndex, resolveEndpoint } from "../lib.mjs";

test("extractRouteCalls finds every router.<method>(path, ...) call in declaration order", () => {
  const source = `
    router.get("/books", requireAuth, async (req, res) => { doA(); });
    router.post("/books/:id", requireAuth, async (req, res) => { doB(); });
  `;
  const calls = extractRouteCalls(source);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => [c.method, c.routePath]), [["GET", "/books"], ["POST", "/books/:id"]]);
});

test("extractLocalImports keeps only relative-specifier imports, resolves aliases, ignores package imports", () => {
  const source = `
    import { Router } from "express";
    import { postJournal, computeAccountBalances as computeBalances } from "../lib/finance-accounting";
    import creditMeter from "../services/credit-meter";
  `;
  const imports = extractLocalImports(source);
  assert.equal(imports.has("Router"), false); // express is a package import, not relative
  assert.equal(imports.get("postJournal"), "../lib/finance-accounting");
  assert.equal(imports.get("computeBalances"), "../lib/finance-accounting"); // aliased import resolves to its local name
  assert.equal(imports.get("creditMeter"), "../services/credit-meter");
});

test("buildRouteIndex applies the '/api' prefix by default and the given override for standalone-mounted files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lineage-test-"));
  fs.writeFileSync(path.join(dir, "finance.ts"), `
    import { postJournal } from "../lib/finance-accounting";
    router.post("/finance/entries", requireAuth, async (req, res) => { await postJournal(req.body); });
  `);
  fs.writeFileSync(path.join(dir, "well-known-jwks.ts"), `
    router.get("/.well-known/jwks.json", async (req, res) => { res.json({}); });
  `);
  const index = buildRouteIndex({ routesDir: dir, prefixByFile: { "well-known-jwks.ts": "" } });
  assert.ok(index.has("POST /api/finance/entries"));
  assert.ok(index.has("GET /.well-known/jwks.json"));
  assert.equal(index.get("POST /api/finance/entries").functions.includes("postJournal"), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("buildRouteIndex keeps the first declaration of a duplicate method+path (Express mount-order semantics)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lineage-test-"));
  fs.writeFileSync(path.join(dir, "dup.ts"), `
    router.get("/x", async (req, res) => { firstHandler(); });
    router.get("/x", async (req, res) => { secondHandler(); });
  `);
  const index = buildRouteIndex({ routesDir: dir, prefixByFile: {} });
  assert.equal(index.get("GET /api/x").line, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("resolveEndpoint returns a resolved entry with file/line/functions when the route index has a match", () => {
  const routeIndex = new Map([["POST /api/finance/entries", { file: "routes/finance.ts", line: 42, module: "routes/finance.ts", functions: ["postJournal"] }]]);
  const endpoint = { method: "POST", path: "/api/finance/entries", owner: "finance", auth: "user" };
  const entry = resolveEndpoint(endpoint, routeIndex);
  assert.equal(entry.resolution.status, "resolved");
  assert.equal(entry.resolution.line, 42);
  assert.deepEqual(entry.resolution.functions, ["postJournal"]);
  assert.equal(entry.critical, true); // auth "user" !== "public"
});

test("resolveEndpoint returns an unresolved entry with a reason when nothing matches, and marks public endpoints non-critical", () => {
  const routeIndex = new Map();
  const endpoint = { method: "GET", path: "/api/admin/break-glass", owner: "admin", auth: "admin" };
  const entry = resolveEndpoint(endpoint, routeIndex);
  assert.equal(entry.resolution.status, "unresolved");
  assert.ok(entry.resolution.reason.length > 0);
  assert.equal(entry.critical, true);

  const publicEndpoint = { method: "GET", path: "/api/", owner: "platform", auth: "public" };
  const publicEntry = resolveEndpoint(publicEndpoint, routeIndex);
  assert.equal(publicEntry.critical, false);
});
