# Telegram Phase 3 + 4 — launcher, unified registry, per-bot binding

## Phase 3
- `packages/telegram` `BOT_REGISTRY` is the single registry (adds `tokenEnv`, `responsibility`, `service`, **`fyra`**). The API registry is derived from it; a drift test guards it.
- Module map alignment: ryft = Wallet, fyra = Finance, verve = Marketplace. FYRA gets the finance commands; RYFT keeps its legacy finance commands until wallet capabilities exist.
- `lib/telegram-launcher.ts`: every module bot with a token runs `getMe`, then `setWebhook` to `<api host>/api/telegram/gateway/<key>/webhook` (secret_token, `TELEGRAM_DROP_PENDING_UPDATES`), else per-bot polling (409 backoff, 401/404 stop). AYZENX is still started by `lib/telegram.ts`.
- `GET /api/telegram/bots` (admin; `?refresh=true`): token/secret configured, getMe ok, username, transport, webhook URL, pending updates, last error.
- Bug fix: `telegram_update_receipts.error` column was written but never created.
- Webhook secret compare is now constant-time with a 16-char minimum. Bots now actually reply in chat (previously the adapter result was only the HTTP body, which Telegram ignores).

## Phase 4
- Tables `telegram_bot_links` (unique `(user_id, bot_key)` and `(bot_key, chat_id)`) and `telegram_link_codes` (hashed, single-use, 10 min). Migration `124_telegram_bot_links.sql`, mirrored in `schema-migrations.ts`.
- Endpoints: `GET /telegram/links`, `POST /telegram/bots/:botKey/link/start|verify`, `GET /telegram/bots/:botKey/me`, `PATCH .../active`, `DELETE .../link`. AYZENX keeps the legacy endpoints (409 `USE_LEGACY_TELEGRAM_ENDPOINTS`). Admin bot linking needs the admin role and `TELEGRAM_ADMIN_OWNER_ID`.
- Bot side: `/start <code>`, `/connect`, `/disconnect` (private chats only). Unlinked/inactive chats get a "link your account" reply.
- Adapters resolve chat -> user through the per-bot link (sender must match the linking Telegram user). **No fallback to `users.telegram_chat_id`.**

## Known, not changed
- `validate-track-f` already failed at baseline (endpoint registry drift in finance/vault). Only the 6 new telegram entries were added.
- `packages/telegram/test/policy-contract-adapter.test.mjs` fails at baseline (`@ayzen/authorization` not resolvable).
- Multiple API instances polling the same bot will 409; use webhook transport in production.
