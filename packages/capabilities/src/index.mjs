import { assertCommandTreeValid, deepFreeze, flattenCommandTree, subCommand, topCommand } from "./command-tree.mjs";

export const CAPABILITY_STATUSES = Object.freeze(["available", "partial", "missing", "deprecated", "internal"]);

// Column 8 ("sensitive") is Track H, Phase H4's addition: whether this
// capability requires step-up per packages/authorization's
// authorizeCapability(). It lives here now instead of being a second,
// hand-maintained table in packages/authorization/src/index.mjs — see that
// file's header for why duplicating it was itself the drift H4 closes.
// NOTE: sensitivity does not follow mechanically from `permission` (the scope
// string) — identity.issue-session and identity.revoke-session share the
// scope "identity:session:write" but only the latter is sensitive — so this
// is a deliberate per-capability editorial call, not derived.
const definitions = [
  ["identity.authenticate", "identity", "POST", "/api/auth/login", "available", "identity:authenticate", "auth.login", false],
  ["identity.issue-session", "identity", "POST", "/api/auth/session", "available", "identity:session:write", "session.created", false],
  ["identity.revoke-session", "identity", "POST", "/api/auth/logout", "available", "identity:session:write", "session.revoked", true],
  ["workspace.get-workspace", "workspace", "GET", "/api/workspaces/:workspaceId", "available", "workspace:read", "workspace.read", false],
  ["workspace.list-members", "workspace", "GET", "/api/workspaces/:workspaceId/members", "available", "workspace:read", "workspace.members.read", false],
  ["workspace.add-member", "workspace", "POST", "/api/workspaces/:workspaceId/members", "partial", "workspace:membership:write", "workspace.member.added", true],
  ["workspace.remove-member", "workspace", "DELETE", "/api/workspaces/:workspaceId/members/:userId", "partial", "workspace:membership:write", "workspace.member.removed", true],
  ["finance.list-accounts", "finance", "GET", "/api/finance/accounts", "available", "finance:read", "finance.accounts.read", false],
  ["finance.get-balance", "finance", "GET", "/api/finance/accounts/:accountId/balance", "partial", "finance:read", "finance.balance.read", false],
  ["finance.post-transaction", "finance", "POST", "/api/finance/accounts/:accountId/transactions", "available", "finance:write", "finance.transaction.created", true],
  ["vault.list-secrets", "vault", "GET", "/api/vault", "partial", "vault:read", "vault.listed", false],
  ["vault.create-secret", "vault", "POST", "/api/vault", "partial", "vault:write", "vault.secret.updated", true],
  ["vault.read-secret", "vault", "POST", "/api/vault/:secretId/reveal", "partial", "vault:read", "vault.secret.accessed", true],
  ["mail.list-messages", "mail", "GET", "/api/mail/messages", "available", "mail:read", "wisp.message.listed", false],
  ["mail.read-thread", "mail", "GET", "/api/mail/threads/:threadId", "available", "mail:read", "wisp.thread.read", false],
  ["mail.send-message", "mail", "POST", "/api/mail/messages", "available", "mail:send", "wisp.message.sent", true],
  ["mail.create-draft", "mail", "POST", "/api/mail/drafts", "available", "mail:write", "wisp.draft.created", false],
  ["mail.update-message", "mail", "PATCH", "/api/mail/messages/:id", "available", "mail:write", "wisp.message.updated", false],
  ["mail.manage-permissions", "mail", "PUT", "/api/mail/mailboxes/:mailboxId/permissions", "available", "mail:write", "wisp.mailbox.permissions.updated", true],
  ["mail.search", "mail", "GET", "/api/mail/search", "available", "mail:read", "wisp.search.executed", false],
  ["notification.create-notification", "notification", "POST", "/api/notifications", "available", "notification:write", "notification.requested", false],
  ["notification.list-notifications", "notification", "GET", "/api/notifications", "available", "notification:read", "notification.listed", false],
  ["workflow.start-execution", "workflow", "POST", "/api/workflows/:workflowId/executions", "partial", "workflow:write", "workflow.started", true],
  ["workflow.cancel-execution", "workflow", "POST", "/api/workflows/executions/:executionId/cancel", "partial", "workflow:write", "workflow.cancelled", true],
  ["workflow.get-execution", "workflow", "GET", "/api/workflows/executions/:executionId", "partial", "workflow:read", "workflow.read", false],
  ["ai.run-agent", "ai", "POST", "/api/ai/agents/:agentId/runs", "partial", "ai:execute", "ai.task.requested", true],
  ["search.search", "search", "GET", "/api/search", "available", "search:read", "search.executed", false],
  ["workspace.switch-context", "workspace", "POST", "/api/workspaces/:workspaceId/context", "available", "workspace:read", "workspace.context.switched", false],
  ["workspace.activity", "workspace", "GET", "/api/workspaces/:workspaceId/activity", "available", "workspace:read", "workspace.activity.read", false],
  ["marketplace.list", "marketplace", "GET", "/api/marketplace/listings", "available", "verve:read", "marketplace.listed", false],
  ["marketplace.create-listing", "marketplace", "POST", "/api/marketplace/listings", "partial", "verve:write", "marketplace.listing.created", true],
  ["organization.report", "workspace", "GET", "/api/workspaces/:workspaceId/reports", "partial", "warde:read", "organization.report.read", false],
  ["organization.manage-members", "workspace", "PATCH", "/api/workspaces/:workspaceId/members/:userId", "partial", "warde:write", "workspace.member.updated", true],
  ["admin.read", "admin", "GET", "/api/admin/health", "available", "admin:read", "admin.viewed", false],
  ["admin.audit", "admin", "GET", "/api/admin/audits", "available", "admin:audit", "admin.audit.read", false],
  ["admin.data-read", "admin", "POST", "/api/admin/data/query", "available", "admin:data:read", "admin.data.query", true],
  ["admin.data-write", "admin", "POST", "/api/admin/data/mutate", "available", "admin:data:write", "admin.data.mutate", true],
  ["admin.break-glass", "admin", "POST", "/api/admin/break-glass", "available", "admin:break-glass", "admin.break_glass.issued", true],
  // Referenced by /incident and /deploy (and declared in packages/authorization) but no backing
  // route exists yet, so they are "missing": the Telegram adapter fails closed with 501 for both.
  ["admin.remediate", "admin", "POST", "/api/admin/incidents/:incidentId/remediate", "missing", "admin:remediate", "admin.incident.remediated", true],
  ["admin.deploy", "admin", "POST", "/api/admin/deployments", "missing", "admin:deploy", "admin.deployment.requested", true],
  ["admin.xuka-status", "admin", "GET", "/api/admin/xuka/phases", "available", "admin:read", "admin.xuka.phases.read", false],
  ["admin.xuka-validate", "admin", "POST", "/api/admin/xuka/validate", "available", "admin:read", "admin.xuka.validate", false],
  ["admin.xuka-preview", "admin", "POST", "/api/admin/xuka/preview", "available", "admin:read", "admin.xuka.preview", false],
  ["admin.xuka-inspect", "admin", "POST", "/api/admin/xuka/inspect", "available", "admin:read", "admin.xuka.inspect", false],
];

export const CAPABILITY_REGISTRY = Object.freeze(definitions.map(([capability, domain, method, route, status, permission, auditEvent, sensitive]) => Object.freeze({
  capability, domain, method, route, status, permission, auditEvent, sensitive,
})));

const byCapability = new Map(CAPABILITY_REGISTRY.map((entry) => [entry.capability, entry]));

// Route template -> RegExp, e.g. "/api/finance/accounts/:accountId/transactions"
// -> /^\/api\/finance\/accounts\/[^/]+\/transactions$/. Built once per entry,
// not per request.
const ROUTE_PATTERNS = new Map(CAPABILITY_REGISTRY.map((entry) => [
  entry.capability,
  new RegExp(`^${entry.route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:[^/]+/g, "[^/]+")}$`),
]));

/**
 * Phase H4: resolves the capability a raw HTTP request maps to, by method +
 * path — the same (method, route) pairs already used to build Telegram's
 * command -> HTTP-call bridge (see @ayzen/telegram's normalizeTelegramMessage
 * and the api-server's own route table), so an extracted service's own
 * request matches the identical capability the monolith and Telegram already
 * agree on for that route. Returns undefined for a path with no registered
 * capability (health checks, /internal/*, etc.) — callers should treat that
 * as "not policy-gated", not as a denial.
 */
export function matchCapabilityRoute(method, pathname) {
  const upperMethod = String(method ?? "").toUpperCase();
  for (const entry of CAPABILITY_REGISTRY) {
    if (entry.method !== upperMethod) continue;
    if (ROUTE_PATTERNS.get(entry.capability).test(pathname)) return entry;
  }
  return undefined;
}

export function listCapabilities({ domain, status } = {}) {
  return CAPABILITY_REGISTRY.filter((entry) => (!domain || entry.domain === domain) && (!status || entry.status === status));
}

export function getCapability(capability) {
  return byCapability.get(capability);
}

export function assertCapabilityRegistered(capability) {
  const entry = getCapability(capability);
  if (!entry) throw new Error(`Capability is not registered: ${capability}`);
  return entry;
}

export function assertCapabilityAvailable(capability) {
  const entry = assertCapabilityRegistered(capability);
  if (entry.status !== "available") {
    const error = new Error(`Capability is ${entry.status}: ${capability}`);
    error.code = "CAPABILITY_NOT_AVAILABLE";
    error.capability = capability;
    error.status = entry.status;
    throw error;
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Telegram command tree (Track E). Commands are Feature -> Sub-feature trees;
// the flat TELEGRAM_COMMAND_DEFINITIONS below is derived from this tree, so the
// two can never drift. Legacy flat commands that now live under a parent are
// kept as deprecated aliases (still resolvable, hidden from generated /help).
// ---------------------------------------------------------------------------
const c = topCommand;
const s = subCommand;

export const COMMAND_TREE_DEFINITIONS = deepFreeze([
  // AYZENX — personal workspace and shared platform entry points.
  c("ayzenx", "/start", "identity.authenticate"),
  c("ayzenx", "/help", "identity.authenticate"),
  c("ayzenx", "/connect", "identity.authenticate"),
  c("ayzenx", "/workspace", "workspace.switch-context"),
  c("ayzenx", "/activity", "workspace.activity"),
  c("ayzenx", "/search", "search.search"),
  c("ayzenx", "/notifications", "notification.list-notifications"),
  c("ayzenx", "/settings", "workspace.get-workspace"),
  c("ayzenx", "/permissions", "workspace.get-workspace"),
  // WARDE — organization and business workspace.
  c("warde", "/start", "identity.authenticate"),
  c("warde", "/help", "identity.authenticate"),
  c("warde", "/report", "organization.report"),
  c("warde", "/members", "workspace.list-members"),
  c("warde", "/invite", "workspace.add-member"),
  c("warde", "/activity", "workspace.activity"),
  c("warde", "/settings", "workspace.get-workspace"),
  // VERVE — marketplace.
  c("verve", "/start", "identity.authenticate"),
  c("verve", "/help", "identity.authenticate"),
  c("verve", "/listings", "marketplace.list"),
  c("verve", "/listing", "marketplace.create-listing"),
  c("verve", "/search", "search.search"),
  c("verve", "/activity", "workspace.activity"),
  // RYFT — finance.
  c("ryft", "/start", "identity.authenticate"),
  c("ryft", "/help", "identity.authenticate"),
  c("ryft", "/accounts", "finance.list-accounts"),
  c("ryft", "/balance", "finance.get-balance"),
  c("ryft", "/transactions", "finance.list-accounts"),
  c("ryft", "/transaction", "finance.post-transaction"),
  c("ryft", "/activity", "workspace.activity"),
  // SYLO — secure vault. /vault is the parent; /secret and /reveal are deprecated flat aliases.
  c("sylo", "/start", "identity.authenticate"),
  c("sylo", "/help", "identity.authenticate"),
  c("sylo", "/vault", "vault.list-secrets", {
    subcommands: [
      s("list", "vault.list-secrets"),
      s("create", "vault.create-secret"),
      s("reveal", "vault.read-secret"),
    ],
  }),
  c("sylo", "/secret", "vault.create-secret", { deprecated: true, replacement: "/vault create" }),
  c("sylo", "/reveal", "vault.read-secret", { deprecated: true, replacement: "/vault reveal" }),
  c("sylo", "/activity", "workspace.activity"),
  // SKARN — project and workflow operations.
  c("skarn", "/start", "identity.authenticate"),
  c("skarn", "/help", "identity.authenticate"),
  c("skarn", "/project", "workspace.get-workspace"),
  c("skarn", "/workflow", "workflow.get-execution"),
  c("skarn", "/run", "workflow.start-execution"),
  c("skarn", "/cancel", "workflow.cancel-execution"),
  c("skarn", "/tasks", "workflow.get-execution"),
  c("skarn", "/events", "workspace.activity"),
  c("skarn", "/audit", "workspace.activity"),
  // ZYNTH — AI and intelligence.
  c("zynth", "/start", "identity.authenticate"),
  c("zynth", "/help", "identity.authenticate"),
  c("zynth", "/ask", "ai.run-agent"),
  c("zynth", "/agents", "ai.run-agent"),
  c("zynth", "/history", "ai.run-agent"),
  c("zynth", "/activity", "workspace.activity"),
  // WISP — mailbox.
  c("wisp", "/start", "identity.authenticate"),
  c("wisp", "/help", "identity.authenticate"),
  c("wisp", "/inbox", "mail.list-messages"),
  c("wisp", "/read", "mail.read-thread"),
  c("wisp", "/send", "mail.send-message"),
  c("wisp", "/search", "mail.search"),
  c("wisp", "/notifications", "notification.list-notifications"),
  // Admin is a separate privileged control-plane bot. /data and /incident are
  // parents; /mutate, /ack and /resolve are deprecated flat aliases.
  c("admin", "/start", "identity.authenticate"),
  c("admin", "/help", "admin.read"),
  c("admin", "/admin", "admin.read"),
  c("admin", "/health", "admin.read"),
  c("admin", "/alerts", "admin.read"),
  c("admin", "/gaps", "admin.read"),
  c("admin", "/tickets", "admin.read"),
  c("admin", "/audit", "admin.audit"),
  c("admin", "/data", "admin.data-read", {
    subcommands: [
      s("read", "admin.data-read"),
      s("write", "admin.data-write"),
    ],
  }),
  c("admin", "/mutate", "admin.data-write", { deprecated: true, replacement: "/data write" }),
  c("admin", "/breakglass", "admin.break-glass"),
  c("admin", "/incident", "admin.remediate", {
    subcommands: [
      s("ack", "admin.remediate"),
      s("resolve", "admin.remediate"),
    ],
  }),
  c("admin", "/ack", "admin.remediate", { deprecated: true, replacement: "/incident ack" }),
  c("admin", "/resolve", "admin.remediate", { deprecated: true, replacement: "/incident resolve" }),
  c("admin", "/deploy", "admin.deploy"),
]);

// The Track E gate: a tree that references an unregistered capability, has an
// empty node, duplicate tokens, or a deprecated alias whose replacement changes
// behaviour fails at import time instead of at runtime.
assertCommandTreeValid(COMMAND_TREE_DEFINITIONS, { getCapability });

// Legacy flat view, derived from the tree (top-level commands only), so every
// pre-migration flat command still resolves exactly as before.
export const TELEGRAM_COMMAND_DEFINITIONS = Object.freeze(flattenCommandTree(COMMAND_TREE_DEFINITIONS).map((entry) => Object.freeze(entry)));
export const TELEGRAM_CAPABILITY_MAP = Object.freeze(Object.fromEntries(
  TELEGRAM_COMMAND_DEFINITIONS.reduce((entries, { bot, command, capability }) => {
    if (!entries.some(([token]) => token === command)) entries.push([command, { bot, capability }]);
    return entries;
  }, []),
));
const TELEGRAM_COMMANDS_BY_BOT = Object.freeze(Object.fromEntries(
  [...new Set(TELEGRAM_COMMAND_DEFINITIONS.map(({ bot }) => bot))].map((bot) => [
    bot,
    Object.freeze(Object.fromEntries(
      TELEGRAM_COMMAND_DEFINITIONS.filter((entry) => entry.bot === bot).map(({ command, capability }) => [command, { bot, capability }]),
    )),
  ]),
));

export function listTelegramCommands({ bot } = {}) {
  return TELEGRAM_COMMAND_DEFINITIONS.filter((item) => !bot || item.bot === bot);
}

export function resolveTelegramCommand(command, { botKey } = {}) {
  const token = String(command ?? "").trim().split(/\s+/)[0].toLowerCase();
  return (botKey && TELEGRAM_COMMANDS_BY_BOT[botKey]?.[token]) ?? TELEGRAM_CAPABILITY_MAP[token];
}
