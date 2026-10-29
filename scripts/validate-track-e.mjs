#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  COMMAND_TREE_DEFINITIONS,
  TELEGRAM_COMMAND_DEFINITIONS,
  getCapability,
  listTelegramCommands,
} from "../packages/capabilities/src/index.mjs";
import { validateCommandTree, topCommand, subCommand } from "../packages/capabilities/src/command-tree.mjs";
import { resolveCommandTreePath, renderCommandTreeHelp, renderSubcommandHelp } from "../packages/telegram/src/command-parser.mjs";

// --- Phase E1: schema + gate -------------------------------------------
// The real tree already validates at import time (index.mjs calls
// assertCommandTreeValid before exporting), so a successful import above is
// itself evidence the gate is wired in. Prove the gate actually rejects bad
// input too, so a future edit can't quietly turn it into a no-op.
{
  const badTree = [topCommand("sylo", "/vault", "vault.nonexistent-capability")];
  const errors = validateCommandTree(badTree, { getCapability });
  assert.ok(errors.length >= 1, "validateCommandTree did not reject an unregistered capability");
  assert.ok(errors[0].includes("vault.nonexistent-capability"), "validation error did not name the offending capability");

  const emptyNode = [topCommand("sylo", "/orphan", undefined)];
  assert.ok(validateCommandTree(emptyNode, { getCapability }).length >= 1, "validateCommandTree accepted a node with no capability and no subcommands");

  const dupeToken = [topCommand("sylo", "/dupe", "vault.list-secrets", {
    subcommands: [subCommand("x", "vault.list-secrets"), subCommand("x", "vault.create-secret")],
  })];
  assert.ok(validateCommandTree(dupeToken, { getCapability }).length >= 1, "validateCommandTree accepted duplicate subcommand tokens");

  assert.deepEqual(validateCommandTree(COMMAND_TREE_DEFINITIONS, { getCapability }), [], "the live command tree has validation errors");
}

// --- Phase E2: hierarchical parser + auto-generated help ---------------
{
  const vaultReveal = resolveCommandTreePath("/vault reveal my-secret", { botKey: "sylo" });
  assert.equal(vaultReveal?.capability, "vault.read-secret", "/vault reveal did not resolve to vault.read-secret");
  assert.deepEqual(vaultReveal.args, ["my-secret"], "/vault reveal did not shift its argument past the subcommand token");

  const vaultBare = resolveCommandTreePath("/vault", { botKey: "sylo" });
  assert.equal(vaultBare?.capability, "vault.list-secrets", "bare /vault must keep resolving to vault.list-secrets");
  assert.deepEqual(vaultBare.path, [], "bare /vault must not report a subcommand path");

  const dataWrite = resolveCommandTreePath("/data write foo", { botKey: "admin" });
  assert.equal(dataWrite?.capability, "admin.data-write", "/data write did not resolve to admin.data-write");

  const incidentAck = resolveCommandTreePath("/incident ack 123", { botKey: "admin" });
  assert.equal(incidentAck?.capability, "admin.remediate", "/incident ack did not resolve to admin.remediate");
  assert.deepEqual(incidentAck.path, ["ack"], "/incident ack did not record its subcommand path");

  assert.equal(resolveCommandTreePath("/breakglass", { botKey: "warde" }), null, "a command owned by another bot must not resolve");

  const unknownSubcommand = resolveCommandTreePath("/vault teleport", { botKey: "sylo" });
  assert.equal(unknownSubcommand.capability, "vault.list-secrets", "an unmatched subcommand token must fall back to the parent's own capability");
  assert.deepEqual(unknownSubcommand.args, ["teleport"], "an unmatched subcommand token must be returned as an argument, not silently dropped");

  // Snapshot: tree definition in, expected /help output out, for every bot
  // that owns at least one command.
  const expectedHelp = {
    ayzenx: "ayzenx commands:\n/start\n/help\n/connect\n/workspace\n/activity\n/search\n/notifications\n/settings\n/permissions",
    warde: "warde commands:\n/start\n/help\n/report\n/members\n/invite\n/activity\n/settings",
    verve: "verve commands:\n/start\n/help\n/listings\n/listing\n/search\n/activity",
    ryft: "ryft commands:\n/start\n/help\n/accounts\n/balance\n/transactions\n/transaction\n/activity",
    sylo: "sylo commands:\n/start\n/help\n/vault — list, create, reveal\n/activity",
    skarn: "skarn commands:\n/start\n/help\n/project\n/workflow\n/run\n/cancel\n/tasks\n/events\n/audit",
    zynth: "zynth commands:\n/start\n/help\n/ask\n/agents\n/history\n/activity",
    wisp: "wisp commands:\n/start\n/help\n/inbox\n/read\n/send\n/search\n/notifications",
    admin: "admin commands:\n/start\n/help\n/admin\n/health\n/alerts\n/gaps\n/tickets\n/audit\n/data — read, write\n/breakglass\n/incident — ack, resolve\n/deploy",
  };
  for (const [bot, expected] of Object.entries(expectedHelp)) {
    assert.equal(renderCommandTreeHelp(bot), expected, `/help output for ${bot} drifted from the tree definition`);
  }
  assert.ok(!renderCommandTreeHelp("sylo").includes("/secret"), "deprecated aliases must not appear in generated help");
  assert.ok(!renderCommandTreeHelp("admin").includes("/mutate"), "deprecated aliases must not appear in generated help");

  assert.ok(renderSubcommandHelp("sylo", "/vault").includes("/vault reveal"), "/vault help must list its sub-features");
  assert.equal(renderSubcommandHelp("sylo", "/activity"), "/activity takes no sub-features.");
}

// --- Phase E3: pre-migration flat commands still resolve (deprecated alias) ---
{
  const originalFlatCommands = [
    ["sylo", "/vault", "vault.list-secrets"],
    ["sylo", "/secret", "vault.create-secret"],
    ["sylo", "/reveal", "vault.read-secret"],
    ["admin", "/data", "admin.data-read"],
    ["admin", "/mutate", "admin.data-write"],
    ["admin", "/incident", "admin.remediate"],
    ["admin", "/ack", "admin.remediate"],
    ["admin", "/resolve", "admin.remediate"],
    ["admin", "/deploy", "admin.deploy"],
  ];
  for (const [bot, command, capability] of originalFlatCommands) {
    const flatEntry = TELEGRAM_COMMAND_DEFINITIONS.find((entry) => entry.bot === bot && entry.command === command);
    assert.ok(flatEntry, `${bot} ${command} is no longer present in TELEGRAM_COMMAND_DEFINITIONS — this is a breaking change for existing bot users`);
    assert.equal(flatEntry.capability, capability, `${bot} ${command} changed capability during the Track E migration`);

    const resolved = resolveCommandTreePath(command, { botKey: bot });
    assert.equal(resolved?.capability, capability, `${bot} ${command} no longer resolves via the hierarchical parser`);
  }
  assert.equal(resolveCommandTreePath("/mutate", { botKey: "admin" }).deprecated, true, "/mutate must be flagged deprecated");
  assert.equal(resolveCommandTreePath("/mutate", { botKey: "admin" }).replacement, "/data write", "/mutate must point at its replacement");

  // Every capability referenced anywhere in the tree must be a real,
  // registered capability — this is what would have caught the
  // admin.remediate / admin.deploy gap before it ever reached runtime.
  for (const { bot, command, capability } of TELEGRAM_COMMAND_DEFINITIONS) {
    assert.ok(getCapability(capability), `${bot} ${command} references unregistered capability ${capability}`);
  }

  assert.ok(listTelegramCommands().length >= 50, "Telegram command registry regressed below the Track A-D floor");
}

console.log("Track E validation passed: command tree schema + gate, hierarchical parser, auto-generated help, and deprecated-alias backward compatibility.");
