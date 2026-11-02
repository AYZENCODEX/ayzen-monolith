import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BOT_REGISTRY } from "@ayzen/telegram";
import { listTelegramCommands } from "@ayzen/capabilities";
import { TELEGRAM_BOT_REGISTRY, getTelegramBotDescriptor } from "./telegram-bot-registry";

const CONFIRMED_TOKEN_ENV = {
  ayzenx: "TELEGRAM_BOT_TOKEN",
  verve: "VERVE_TELEGRAM_BOT_TOKEN",
  sylo: "SYLO_TELEGRAM_BOT_TOKEN",
  skarn: "SKARN_TELEGRAM_BOT_TOKEN",
  warde: "WARDE_TELEGRAM_BOT_TOKEN",
  ryft: "RYFT_TELEGRAM_BOT_TOKEN",
  fyra: "FYRA_TELEGRAM_BOT_TOKEN",
  zynth: "ZYNTH_TELEGRAM_BOT_TOKEN",
  wisp: "WISP_TELEGRAM_BOT_TOKEN",
} as const;

test("confirmed Telegram bot token environment names match the registry", () => {
  for (const [key, envVar] of Object.entries(CONFIRMED_TOKEN_ENV)) {
    assert.equal(getTelegramBotDescriptor(key)?.tokenEnvVar, envVar, `${key} token environment name`);
  }
});

test("the migration seed keeps existing bot rows aligned with confirmed token names", () => {
  const migrationPath = new URL("./schema-migrations.ts", import.meta.url);
  const source = readFileSync(migrationPath, "utf8");
  const seedStart = source.indexOf("INSERT INTO telegram_bots (bot_key, display_name, responsibility, token_env_var)");
  assert.notEqual(seedStart, -1, "telegram bot seed exists");
  const seedEnd = source.indexOf("ON CONFLICT (bot_key)", seedStart);
  assert.notEqual(seedEnd, -1, "telegram bot seed has conflict handling");
  const seed = source.slice(seedStart, seedEnd);

  for (const [key, envVar] of Object.entries(CONFIRMED_TOKEN_ENV)) {
    assert.match(seed, new RegExp(`\\('${key}',[^\\n]*'${envVar}'\\)`), `${key} migration seed environment name`);
  }
  assert.match(source.slice(seedEnd, seedEnd + 120), /DO UPDATE SET token_env_var = EXCLUDED\.token_env_var/);
});

test("admin token mapping remains separate because no confirmed admin env key exists", () => {
  assert.equal(getTelegramBotDescriptor("admin")?.tokenEnvVar, "TELEGRAM_ADMIN_BOT_TOKEN");
});

test("one source of truth: the API registry is derived from packages/telegram BOT_REGISTRY", () => {
  assert.deepEqual(TELEGRAM_BOT_REGISTRY.map((b) => b.key), Object.keys(BOT_REGISTRY));
  for (const bot of TELEGRAM_BOT_REGISTRY) {
    assert.equal(bot.tokenEnvVar, BOT_REGISTRY[bot.key].tokenEnv, `${bot.key} token env`);
    assert.equal(bot.webhookSecretEnvVar, BOT_REGISTRY[bot.key].secretEnv, `${bot.key} secret env`);
  }
});

test("every registered bot has a webhook secret env named TELEGRAM_<KEY>_WEBHOOK_SECRET (ayzenx keeps the legacy name)", () => {
  for (const bot of TELEGRAM_BOT_REGISTRY) {
    const expected = bot.key === "ayzenx" ? "TELEGRAM_WEBHOOK_SECRET" : `TELEGRAM_${bot.key.toUpperCase()}_WEBHOOK_SECRET`;
    assert.equal(bot.webhookSecretEnvVar, expected);
  }
});

test("module map alignment: fyra is the Finance bot, ryft the Wallet bot, verve the Marketplace bot", () => {
  assert.equal(getTelegramBotDescriptor("fyra")?.responsibility, "Finance");
  assert.equal(getTelegramBotDescriptor("ryft")?.responsibility, "Wallet");
  assert.equal(getTelegramBotDescriptor("verve")?.responsibility, "Marketplace");
  assert.equal(getTelegramBotDescriptor("wisp")?.responsibility, "Mailbox / email");
});

test("every registered bot except ayzenx has capability commands (so its adapter can answer /help)", () => {
  for (const bot of TELEGRAM_BOT_REGISTRY.filter((b) => b.key !== "ayzenx")) {
    assert.ok(listTelegramCommands({ bot: bot.key }).length > 0, `${bot.key} has no registered commands`);
  }
});

test("every module bot has a domain adapter registered", () => {
  const source = readFileSync(new URL("./telegram-adapters/index.ts", import.meta.url), "utf8");
  for (const bot of TELEGRAM_BOT_REGISTRY.filter((b) => b.key !== "ayzenx")) {
    assert.match(source, new RegExp(`\\b${bot.key}: adapter\\(`), `${bot.key} adapter`);
  }
});

test("the migration seeds every registered bot (fyra and admin included)", () => {
  const source = readFileSync(new URL("./schema-migrations.ts", import.meta.url), "utf8");
  const seed = source.slice(source.indexOf("INSERT INTO telegram_bots"), source.indexOf("ON CONFLICT (bot_key)"));
  for (const bot of TELEGRAM_BOT_REGISTRY) {
    assert.match(seed, new RegExp(`\\('${bot.key}',[^\\n]*'${bot.tokenEnvVar}'\\)`), `${bot.key} seed row`);
  }
});

test("the receipts table has the error column the gateway writes, and the link tables are migrated", () => {
  const source = readFileSync(new URL("./schema-migrations.ts", import.meta.url), "utf8");
  assert.match(source, /ALTER TABLE telegram_update_receipts ADD COLUMN IF NOT EXISTS error TEXT/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS telegram_bot_links/);
  assert.match(source, /CREATE UNIQUE INDEX IF NOT EXISTS telegram_bot_links_user_bot_idx/);
  assert.match(source, /CREATE UNIQUE INDEX IF NOT EXISTS telegram_bot_links_bot_chat_idx/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS telegram_link_codes/);
});
