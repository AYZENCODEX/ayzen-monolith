import assert from "node:assert/strict";
import test from "node:test";
import { selectDatabaseUrl } from "../src/index.mjs";

test("app target uses only APP_DATABASE_URL", () => {
  assert.equal(
    selectDatabaseUrl({ env: { APP_DATABASE_URL: "postgres://app", DATABASE_URL: "postgres://replit" } }),
    "postgres://app",
  );
});

test("app target never falls back to the Replit-managed database", () => {
  assert.equal(
    selectDatabaseUrl({ env: { DATABASE_URL: "postgres://replit" } }),
    undefined,
  );
});

test("replit-test target uses only the managed DATABASE_URL", () => {
  assert.equal(
    selectDatabaseUrl({
      env: { APP_DATABASE_URL: "postgres://app", DATABASE_URL: "postgres://replit" },
      target: "replit-test",
    }),
    "postgres://replit",
  );
  assert.equal(
    selectDatabaseUrl({ env: { APP_DATABASE_URL: "postgres://app" }, target: "replit-test" }),
    undefined,
  );
});

test("DATABASE_URL_TARGET selects the Replit test database", () => {
  assert.equal(
    selectDatabaseUrl({
      env: {
        APP_DATABASE_URL: "postgres://app",
        DATABASE_URL: "postgres://replit",
        DATABASE_URL_TARGET: "replit-test",
      },
    }),
    "postgres://replit",
  );
});

test("unknown database targets fail explicitly", () => {
  assert.throws(
    () => selectDatabaseUrl({ env: {}, target: "typo" }),
    /DATABASE_URL_TARGET must be/,
  );
});
