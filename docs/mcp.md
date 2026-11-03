# AYZEN MCP server

Remote MCP server (Model Context Protocol), Streamable HTTP transport, **stateless**.

| | |
|---|---|
| URL | `https://api.ayzen.tech/mcp` (also `https://mcp.ayzen.tech/mcp` via `MCP_HOSTS`; legacy `https://<origin>/api/mcp` still works) |
| Method | `POST` with a JSON-RPC 2.0 body. `GET`/`DELETE` → 405 (no server-initiated stream, no sessions) |
| Auth | `Authorization: Bearer ayzn_live_…` (Settings → Developer → API Keys). Session cookies/JWTs are refused |
| Protocol versions | 2025-06-18, 2025-03-26, 2024-11-05 (`MCP-Protocol-Version` header validated when sent) |
| Capabilities | `tools` only |

## Why stateless, and why no OAuth
- No `Mcp-Session-Id` is issued (allowed by the spec). The app autoscales; in-memory sessions would 404 on another instance.
- OAuth is not offered: the OIDC provider has no dynamic client registration, so advertising it would send clients into a flow that cannot finish. Use an API key.

## Scopes (scoped keys)
A full key can use every tool. A scoped key needs `mcp` **plus** each tool's module scope (tool calls loop back through the normal REST scope gate):

| Tool group | Module scope | Extra |
|---|---|---|
| `ayzen_list/get_vault_entry`, `ayzen_dashboard_summary` | `vault` | `reveal:true` needs `vault-secrets` (or a full key) |
| `ayzen_create/update_vault_entry` | `vault` | `mcp-write` |
| `ayzen_list_projects`, `ayzen_get_project` | `projects` | |
| `ayzen_list_tasks` | `tasks` | |
| `ayzen_list_finance_*` | `finance` | |
| `ayzen_list_mail`, `ayzen_mail_unread_count` | `email` | |
| `ayzen_list_teams`, `ayzen_get_team` | `teams` | |
| `ayzen_list_wallets` | `wallets` | |

`tools/list` only returns tools the key may call. `mcp-write` and `vault-secrets` have no REST path prefix: they never widen REST access.

## Safety
- Secret-looking fields (passwords, seed phrases, tokens, 2FA secrets…) are redacted in every tool result; vault reveal is opt-in per call.
- Tools reject unknown arguments (no mass-assignment); results over 100k chars are truncated.
- `Origin` is validated (no Origin and first-party origins pass; others need `MCP_ALLOWED_ORIGINS`).
- Per-user rate limit: `MCP_RATE_LIMIT_PER_MIN` (default 120), per instance, in memory. 429 + `Retry-After`.
- Each `tools/call` logs `mcp.tool_call` (user, key type, tool, ok, duration, reason). Argument values are never logged.
- Not available through MCP, by design: sending mail, wallet transfers/seed phrases, finance writes.

## Env
`MCP_HOSTS`, `MCP_ALLOWED_ORIGINS`, `MCP_RATE_LIMIT_PER_MIN`, `MCP_INTERNAL_API_BASE` (loopback base, default `http://127.0.0.1:$PORT/api`), `VITE_MCP_URL` (URL shown in the Developer page).

## Tests
`pnpm --filter @workspace/api-server run test:mcp`
