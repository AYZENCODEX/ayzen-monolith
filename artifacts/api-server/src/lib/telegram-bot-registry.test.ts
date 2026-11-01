import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { TELEGRAM_BOT_REGISTRY, getTelegramBotDescriptor } from "./telegram-bot-registry";

const CONFIRMED_TOKEN_ENV = {
  ayzenx: "TELEGRAM_BOT_TOKEN",
  verve: "VERVE_TELEGRAM_BOT_TOKEN",
  sylo: "SYLO_TELEGRAM_BOT_TOKEN",
  skarn: "SKARN_TELEGRAM_BOT_TOKEN",
  warde: "WARDE_TELEGRAM_BOT_TOKEN",
  ryft: "RYFT_TELEGRAM_BOT_TOKEN",
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
