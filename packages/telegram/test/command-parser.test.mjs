import test from "node:test";
import assert from "node:assert/strict";
import { resolveCommandTreePath, renderCommandTreeHelp, renderSubcommandHelp } from "../src/command-parser.mjs";
import { COMMAND_TREE_DEFINITIONS } from "@ayzen/capabilities";

// Snapshot: tree definition in, expected /help output out, for every bot.
// If this drifts, either the snapshot below or COMMAND_TREE_DEFINITIONS
// changed without the other — that's exactly what this test is for.
const EXPECTED_HELP = {
  ayzenx: [
    "ayzenx commands:",
    "/start", "/help", "/connect", "/workspace", "/activity",
    "/search", "/notifications", "/settings", "/permissions",
  ].join("\n"),
  warde: [
    "warde commands:",
    "/start", "/help", "/report", "/members", "/invite", "/activity", "/settings",
  ].join("\n"),
  verve: [
    "verve commands:",
    "/start", "/help", "/listings", "/listing", "/search", "/activity",
  ].join("\n"),
  ryft: [
    "ryft commands:",
    "/start", "/help", "/accounts", "/balance", "/transactions", "/transaction", "/activity",
  ].join("\n"),
  sylo: [
    "sylo commands:",
    "/start", "/help", "/vault — list, create, reveal", "/activity",
  ].join("\n"),
  skarn: [
    "skarn commands:",
    "/start", "/help", "/project", "/workflow", "/run", "/cancel", "/tasks", "/events", "/audit",
  ].join("\n"),
  zynth: [
    "zynth commands:",
    "/start", "/help", "/ask", "/agents", "/history", "/activity",
  ].join("\n"),
  wisp: [
    "wisp commands:",
    "/start", "/help", "/inbox", "/read", "/send", "/search", "/notifications",
  ].join("\n"),
  admin: [
    "admin commands:",
    "/start", "/help", "/admin", "/health", "/alerts", "/gaps", "/tickets", "/audit",
    "/data — read, write", "/breakglass", "/incident — ack, resolve", "/deploy",
  ].join("\n"),
};

for (const [bot, expected] of Object.entries(EXPECTED_HELP)) {
  test(`renderCommandTreeHelp("${bot}") matches the tree definition`, () => {
    assert.equal(renderCommandTreeHelp(bot), expected);
  });
}

test("every bot in COMMAND_TREE_DEFINITIONS has a snapshot", () => {
  const bots = new Set(COMMAND_TREE_DEFINITIONS.map((node) => node.bot));
  assert.deepEqual([...bots].sort(), Object.keys(EXPECTED_HELP).sort());
});

test("deprecated aliases are hidden from generated help but stay resolvable", () => {
  assert.ok(!renderCommandTreeHelp("sylo").includes("/secret"));
  assert.ok(!renderCommandTreeHelp("sylo").includes("/reveal"));
  assert.ok(!renderCommandTreeHelp("admin").includes("/mutate"));
  assert.ok(!renderCommandTreeHelp("admin").includes("/ack"));
  assert.ok(!renderCommandTreeHelp("admin").includes("/resolve"));

  const secret = resolveCommandTreePath("/secret my-name my-value", { botKey: "sylo" });
  assert.equal(secret.capability, "vault.create-secret");
  assert.equal(secret.deprecated, true);
  assert.equal(secret.replacement, "/vault create");
});

test("resolveCommandTreePath walks nested subcommands and shifts args", () => {
  const reveal = resolveCommandTreePath("/vault reveal my-secret", { botKey: "sylo" });
  assert.equal(reveal.command, "/vault");
  assert.deepEqual(reveal.path, ["reveal"]);
  assert.equal(reveal.capability, "vault.read-secret");
  assert.deepEqual(reveal.args, ["my-secret"]);

  const create = resolveCommandTreePath("/vault create my-name my-value", { botKey: "sylo" });
  assert.equal(create.capability, "vault.create-secret");
  assert.deepEqual(create.args, ["my-name", "my-value"]);
});

test("resolveCommandTreePath keeps bare parent-command behavior unchanged", () => {
  const bare = resolveCommandTreePath("/vault", { botKey: "sylo" });
  assert.equal(bare.capability, "vault.list-secrets");
  assert.deepEqual(bare.path, []);
  assert.deepEqual(bare.args, []);
});

test("resolveCommandTreePath scopes strictly to the requesting bot", () => {
  assert.equal(resolveCommandTreePath("/breakglass", { botKey: "warde" }), null);
  assert.equal(resolveCommandTreePath("/vault", { botKey: "ryft" }), null);
});

test("resolveCommandTreePath falls back to the parent's capability on an unrecognized subcommand token", () => {
  const result = resolveCommandTreePath("/vault teleport somewhere", { botKey: "sylo" });
  assert.equal(result.capability, "vault.list-secrets");
  assert.deepEqual(result.path, []);
  assert.deepEqual(result.args, ["teleport", "somewhere"]);
});

test("admin's two-level hierarchy resolves data and incident subcommands", () => {
  const dataWrite = resolveCommandTreePath("/data write foo bar", { botKey: "admin" });
  assert.equal(dataWrite.capability, "admin.data-write");
  assert.deepEqual(dataWrite.args, ["foo", "bar"]);

  const dataRead = resolveCommandTreePath("/data read", { botKey: "admin" });
  assert.equal(dataRead.capability, "admin.data-read");

  const incidentResolve = resolveCommandTreePath("/incident resolve 42", { botKey: "admin" });
  assert.equal(incidentResolve.capability, "admin.remediate");
  assert.deepEqual(incidentResolve.path, ["resolve"]);
});

test("renderSubcommandHelp lists a parent's children and flags leaf commands", () => {
  assert.equal(
    renderSubcommandHelp("sylo", "/vault"),
    "/vault sub-features:\n/vault list\n/vault create\n/vault reveal",
  );
  assert.equal(renderSubcommandHelp("sylo", "/activity"), "/activity takes no sub-features.");
  assert.equal(renderSubcommandHelp("sylo", "/does-not-exist"), null);
});
