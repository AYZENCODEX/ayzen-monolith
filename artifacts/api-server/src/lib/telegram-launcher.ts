/**
 * Telegram launcher for the module bots.
 *
 * AYZENX is started by initTelegramBot() (lib/telegram.ts) and is only
 * *reported* here. Every other bot in the shared registry whose token env var
 * is set is started on boot:
 *   1. getMe            -> proves the token and learns the bot username
 *   2. webhook mode     -> setWebhook to <api host>/api/telegram/gateway/<botKey>/webhook
 *   3. polling fallback -> when webhooks are off (dev), unreachable, or the
 *                          webhook secret is missing/too short
 *
 * Transport selection (TELEGRAM_GATEWAY_TRANSPORT = auto | webhook | polling):
 *   auto (default) = webhook in production, polling elsewhere.
 * Webhook base URL: TELEGRAM_GATEWAY_PUBLIC_URL, else https://api.ayzen.tech.
 * TELEGRAM_DROP_PENDING_UPDATES=true drops queued updates when (re)registering.
 */
import { logger } from "./logger";
import { DEFAULT_API_HOST } from "./api-hosts";
import { TELEGRAM_BOT_REGISTRY, type TelegramBotDescriptor } from "./telegram-bot-registry";
import { deleteWebhook, getMe, getUpdates, getWebhookInfo, setWebhook, TelegramApiError, type TelegramApiOptions } from "./telegram-api";

export type TelegramTransport = "webhook" | "polling" | "legacy" | "none";

export interface TelegramBotRuntimeState {
  botKey: string;
  displayName: string;
  responsibility: string;
  tokenConfigured: boolean;
  webhookSecretConfigured: boolean;
  transport: TelegramTransport;
  getMeOk: boolean | null;
  username: string | null;
  webhookUrl: string | null;
  pendingUpdateCount: number | null;
  lastError: string | null;
  lastCheckedAt: string | null;
}

export type GatewayUpdateHandler = (botKey: string, update: { update_id: number } & Record<string, unknown>) => Promise<void>;

export interface LauncherDeps {
  env?: NodeJS.ProcessEnv;
  api?: TelegramApiOptions;
  handleUpdate: GatewayUpdateHandler;
  /** Test seam: wait between failed polls. */
  sleep?: (ms: number) => Promise<void>;
}

const MIN_SECRET_LENGTH = 16;
const states = new Map<string, TelegramBotRuntimeState>();
const pollers = new Map<string, AbortController>();

function blankState(bot: TelegramBotDescriptor, env: NodeJS.ProcessEnv): TelegramBotRuntimeState {
  return {
    botKey: bot.key,
    displayName: bot.displayName,
    responsibility: bot.responsibility,
    tokenConfigured: Boolean(env[bot.tokenEnvVar]),
    webhookSecretConfigured: Boolean(env[bot.webhookSecretEnvVar]),
    transport: "none",
    getMeOk: null,
    username: null,
    webhookUrl: null,
    pendingUpdateCount: null,
    lastError: null,
    lastCheckedAt: null,
  };
}

function stateFor(bot: TelegramBotDescriptor, env: NodeJS.ProcessEnv): TelegramBotRuntimeState {
  let state = states.get(bot.key);
  if (!state) { state = blankState(bot, env); states.set(bot.key, state); }
  state.tokenConfigured = Boolean(env[bot.tokenEnvVar]);
  state.webhookSecretConfigured = Boolean(env[bot.webhookSecretEnvVar]);
  return state;
}

export function resolveGatewayWebhookUrl(botKey: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.TELEGRAM_GATEWAY_PUBLIC_URL?.trim() || `https://${DEFAULT_API_HOST}`).replace(/\/+$/, "");
  return `${base}/api/telegram/gateway/${botKey}/webhook`;
}

export function resolveGatewayTransport(env: NodeJS.ProcessEnv = process.env): "webhook" | "polling" {
  const configured = env.TELEGRAM_GATEWAY_TRANSPORT?.trim().toLowerCase();
  if (configured === "webhook" || configured === "polling") return configured;
  return env.NODE_ENV === "production" ? "webhook" : "polling";
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

async function startPolling(bot: TelegramBotDescriptor, token: string, state: TelegramBotRuntimeState, deps: LauncherDeps): Promise<void> {
  const env = deps.env ?? process.env;
  // getUpdates answers 409 while a webhook is registered, so clear it first.
  await deleteWebhook(token, env.TELEGRAM_DROP_PENDING_UPDATES === "true", deps.api);
  pollers.get(bot.key)?.abort();
  const controller = new AbortController();
  pollers.set(bot.key, controller);
  state.transport = "polling";
  state.webhookUrl = null;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  void (async () => {
    let offset: number | undefined;
    while (!controller.signal.aborted) {
      try {
        const updates = await getUpdates(token, { offset, timeout: 25 }, { ...deps.api, signal: controller.signal });
        for (const update of updates) {
          offset = update.update_id + 1;
          try { await deps.handleUpdate(bot.key, update); }
          catch (err) { logger.error({ botKey: bot.key, err: errMsg(err) }, "Telegram polled update failed"); }
        }
        state.lastError = null;
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof TelegramApiError && err.isAuthError) {
          state.lastError = "Token rejected by Telegram — polling stopped";
          state.transport = "none";
          state.getMeOk = false;
          logger.error({ botKey: bot.key }, state.lastError);
          return;
        }
        state.lastError = err instanceof TelegramApiError && err.isConflict ? "409: another consumer is polling this bot — retrying" : errMsg(err);
        logger.warn({ botKey: bot.key, err: state.lastError }, "Telegram polling error");
        await sleep(err instanceof TelegramApiError && err.isConflict ? 15_000 : 5_000);
      }
    }
  })();
}

async function startBot(bot: TelegramBotDescriptor, deps: LauncherDeps): Promise<void> {
  const env = deps.env ?? process.env;
  const state = stateFor(bot, env);
  const token = env[bot.tokenEnvVar];
  if (!token) return;

  try {
    const me = await getMe(token, deps.api);
    state.getMeOk = true;
    state.username = me.username ?? null;
    state.lastCheckedAt = new Date().toISOString();
  } catch (err) {
    state.getMeOk = false;
    state.transport = "none";
    state.lastError = `getMe failed: ${errMsg(err)}`;
    state.lastCheckedAt = new Date().toISOString();
    logger.error({ botKey: bot.key, err: state.lastError }, "Telegram bot token check failed — bot not started");
    return;
  }

  const secret = env[bot.webhookSecretEnvVar];
  if (resolveGatewayTransport(env) === "webhook") {
    if (!secret || secret.length < MIN_SECRET_LENGTH) {
      state.lastError = `${bot.webhookSecretEnvVar} missing or shorter than ${MIN_SECRET_LENGTH} chars — using polling`;
      logger.warn({ botKey: bot.key }, state.lastError);
    } else {
      const url = resolveGatewayWebhookUrl(bot.key, env);
      try {
        await setWebhook(token, { url, secretToken: secret, dropPending: env.TELEGRAM_DROP_PENDING_UPDATES === "true" }, deps.api);
        state.transport = "webhook";
        state.webhookUrl = url;
        state.lastError = null;
        logger.info({ botKey: bot.key, username: state.username }, "Telegram bot started (webhook)");
        return;
      } catch (err) {
        state.lastError = `setWebhook failed: ${errMsg(err)} — falling back to polling`;
        logger.warn({ botKey: bot.key, err: state.lastError }, "Telegram webhook registration failed");
      }
    }
  }

  try {
    await startPolling(bot, token, state, deps);
    logger.info({ botKey: bot.key, username: state.username }, "Telegram bot started (polling)");
  } catch (err) {
    state.transport = "none";
    state.lastError = `polling start failed: ${errMsg(err)}`;
    logger.error({ botKey: bot.key, err: state.lastError }, "Telegram bot could not start");
  }
}

/** Starts every configured module bot. One failing bot never blocks the others. */
export async function startTelegramLauncher(deps: LauncherDeps): Promise<void> {
  const env = deps.env ?? process.env;
  const modules = TELEGRAM_BOT_REGISTRY.filter((bot) => bot.key !== "ayzenx");
  for (const bot of modules) stateFor(bot, env);
  const missing = modules.filter((bot) => !env[bot.tokenEnvVar]).map((bot) => bot.key);
  if (missing.length) logger.info({ bots: missing }, "Telegram module bots without a token are skipped");
  await Promise.allSettled(modules.filter((bot) => env[bot.tokenEnvVar]).map((bot) => startBot(bot, deps)));
}

export function stopTelegramLauncher(): void {
  for (const controller of pollers.values()) controller.abort();
  pollers.clear();
  // Webhook registrations are intentionally left in place so a restart/deploy
  // does not drop updates; Telegram retries until the new instance is up.
}

/** Bot username learnt from getMe (null until the launcher or a refresh has seen it). */
export function getKnownBotUsername(botKey: string): string | null {
  return states.get(botKey)?.username ?? null;
}

/**
 * Live status for GET /telegram/bots. `refresh` re-runs getMe + getWebhookInfo
 * against Telegram for every configured module bot. AYZENX state is supplied
 * by the caller because it is owned by lib/telegram.ts.
 */
export async function collectTelegramBotStatus(opts: {
  refresh?: boolean;
  env?: NodeJS.ProcessEnv;
  api?: TelegramApiOptions;
  ayzenx: { transport: "webhook" | "polling" | null; getUsername: () => Promise<string | null> };
}): Promise<TelegramBotRuntimeState[]> {
  const env = opts.env ?? process.env;
  const out: TelegramBotRuntimeState[] = [];
  for (const bot of TELEGRAM_BOT_REGISTRY) {
    const state = stateFor(bot, env);
    if (bot.key === "ayzenx") {
      state.transport = state.tokenConfigured ? (opts.ayzenx.transport ?? "none") : "none";
      if (opts.refresh && state.tokenConfigured) {
        try { state.username = await opts.ayzenx.getUsername(); state.getMeOk = state.username !== null; state.lastError = null; }
        catch (err) { state.getMeOk = false; state.lastError = errMsg(err); }
        state.lastCheckedAt = new Date().toISOString();
      }
    } else if (opts.refresh && state.tokenConfigured) {
      const token = env[bot.tokenEnvVar]!;
      try {
        const me = await getMe(token, opts.api);
        state.getMeOk = true;
        state.username = me.username ?? state.username;
        const info = await getWebhookInfo(token, opts.api);
        state.webhookUrl = info.url || null;
        state.pendingUpdateCount = info.pending_update_count;
        if (info.last_error_message) state.lastError = `Telegram: ${info.last_error_message}`.slice(0, 300);
      } catch (err) {
        state.getMeOk = false;
        state.lastError = errMsg(err);
      }
      state.lastCheckedAt = new Date().toISOString();
    }
    out.push({ ...state });
  }
  return out;
}

/** Test helper. */
export function __resetTelegramLauncherForTests(): void {
  stopTelegramLauncher();
  states.clear();
}
