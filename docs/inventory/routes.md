# Route inventory

| Boundary | Routes or behavior | Owner |
| --- | --- | --- |
| Gateway | `/health`, `/live`, `/ready`, `/metrics`, `/internal/routes` | API gateway |
| Identity | `/api/auth`, OIDC discovery/authorize/token/session flows | Identity |
| Workspace | `/api/workspaces`, `/api/organizations` | Workspace |
| Finance | `/api/finance` | Finance |
| Vault | `/api/vault` | Vault |
| WISP/Mail | `/api/mail`, mailbox and delivery flows | Mail |
| Notifications | `/api/notifications` | Notification |
| Workflow | `/api/workflows` | Workflow |
| AI | `/api/ai` | AI |
| Marketplace | `/api/marketplace` | Marketplace |
| Search | `/api/search` | Search/Knowledge |
| Telegram | `/api/telegram`, bot registry, verified webhooks | Telegram Gateway |

The gateway maps the extracted families to environment-controlled service
URLs and sends all unconfigured families to the compatibility monolith.