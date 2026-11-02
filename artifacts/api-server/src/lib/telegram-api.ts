/**
 * Minimal Telegram Bot API client (fetch based).
 *
 * Used for the module bots (everything except AYZENX, which still runs on
 * node-telegram-bot-api in lib/telegram.ts). The bot token is part of the
 * request URL, so errors thrown from here NEVER include the URL or token.
 */
export class TelegramApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly httpStatus: number | null,
    public readonly telegramCode: number | null,
    description: string,
  ) {
    super(`Telegram ${method} failed${httpStatus ? ` (${httpStatus})` : ""}: ${description}`);
    this.name = "TelegramApiError";
  }
  /** Token revoked / wrong. Retrying will not help. */
  get isAuthError(): boolean {
    return this.httpStatus === 401 || this.httpStatus === 404 || this.telegramCode === 401 || this.telegramCode === 404;
  }
  /** Another getUpdates consumer or a webhook is active for this token. */
  get isConflict(): boolean {
    return this.httpStatus === 409 || this.telegramCode === 409;
  }
}

export interface TelegramApiOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function telegramCall<T>(token: string, method: string, body: Record<string, unknown> = {}, opts: TelegramApiOptions = {}): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    throw new TelegramApiError(method, null, null, err instanceof Error ? err.name : "network error");
  }
  const json = (await response.json().catch(() => null)) as { ok?: boolean; result?: T; error_code?: number; description?: string } | null;
  if (!response.ok || !json?.ok) {
    throw new TelegramApiError(method, response.status, json?.error_code ?? null, String(json?.description ?? "unknown error").slice(0, 200));
  }
  return json.result as T;
}

export interface TelegramBotIdentity { id: number; is_bot: boolean; first_name: string; username?: string }
export interface TelegramWebhookInfo { url: string; pending_update_count: number; last_error_date?: number; last_error_message?: string }

export const getMe = (token: string, o?: TelegramApiOptions) => telegramCall<TelegramBotIdentity>(token, "getMe", {}, o);
export const getWebhookInfo = (token: string, o?: TelegramApiOptions) => telegramCall<TelegramWebhookInfo>(token, "getWebhookInfo", {}, o);
export const deleteWebhook = (token: string, dropPending: boolean, o?: TelegramApiOptions) => telegramCall<boolean>(token, "deleteWebhook", { drop_pending_updates: dropPending }, o);
export const setWebhook = (token: string, args: { url: string; secretToken: string; dropPending: boolean }, o?: TelegramApiOptions) =>
  telegramCall<boolean>(
    token,
    "setWebhook",
    { url: args.url, secret_token: args.secretToken, drop_pending_updates: args.dropPending, allowed_updates: ["message", "edited_message", "callback_query"] },
    o,
  );
export const getUpdates = (token: string, args: { offset?: number; timeout: number }, o?: TelegramApiOptions) =>
  telegramCall<Array<{ update_id: number } & Record<string, unknown>>>(
    token,
    "getUpdates",
    { offset: args.offset, timeout: args.timeout, allowed_updates: ["message", "edited_message", "callback_query"] },
    { ...o, timeoutMs: (args.timeout + 10) * 1000 },
  );
export const sendMessage = (token: string, chatId: string | number, text: string, o?: TelegramApiOptions) =>
  telegramCall<unknown>(token, "sendMessage", { chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }, o);
