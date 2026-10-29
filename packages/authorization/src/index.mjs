import { createAuthorizationContext } from "@ayzen/contracts";
import { CAPABILITY_REGISTRY, matchCapabilityRoute } from "@ayzen/capabilities";

export const AUTHORIZATION_DECISIONS = Object.freeze(["allow", "deny", "step_up_required"]);

// Enforcement Roadmap Track H, Phase H4: this used to be a second,
// hand-maintained {capability -> {scopes, sensitive}} table that drifted
// from @ayzen/capabilities's own CAPABILITY_REGISTRY (identical capability
// names, but no shared source, no lint tying them together, no test that
// would fail if the two were edited independently). Deriving it here instead
// closes exactly the "second, separately-maintained authorization path" the
// roadmap calls out — @ayzen/capabilities.CAPABILITY_REGISTRY is now the
// only place a capability's scope/sensitivity is written down.
const CAPABILITY_POLICIES = new Map(
  CAPABILITY_REGISTRY.map((entry) => [entry.capability, { scopes: entry.permission ? [entry.permission] : [], sensitive: Boolean(entry.sensitive) }]),
);

function capabilityKey(domain, operation) {
  return `${domain}.${operation}`;
}

export function getCapabilityPolicy(capability) {
  return CAPABILITY_POLICIES.get(capability);
}

export function listCapabilityPolicies() {
  return [...CAPABILITY_POLICIES.entries()].map(([capability, policy]) => ({ capability, ...policy, scopes: [...policy.scopes] }));
}

export function requiresStepUp(capability) {
  return Boolean(CAPABILITY_POLICIES.get(capability)?.sensitive);
}

export function createCapabilityRequest({
  subject,
  actorType = "user",
  domain,
  operation,
  organizationId,
  workspaceId,
  scopes = [],
  roles = [],
  stepUpAt,
} = {}) {
  if (!domain || !operation) throw new Error("Authorization domain and operation are required");
  const capability = capabilityKey(domain, operation);
  if (!CAPABILITY_POLICIES.has(capability)) throw new Error(`Unknown capability: ${capability}`);
  return Object.freeze({
    capability,
    auth: { subject, actorType, organizationId, workspaceId, scopes, roles },
    ...(stepUpAt ? { stepUpAt } : {}),
  });
}

export function authorizeCapability({
  capability,
  subject,
  actorType = "user",
  organizationId,
  workspaceId,
  scopes = [],
  roles = [],
  stepUpAt,
  now = Date.now(),
  stepUpWindowMs = 300_000,
} = {}) {
  const policy = CAPABILITY_POLICIES.get(capability);
  if (!policy) {
    return { decision: "deny", reason: "UNKNOWN_CAPABILITY", capability };
  }
  if (typeof subject !== "string" || !subject.trim()) {
    return { decision: "deny", reason: "AUTHENTICATED_SUBJECT_REQUIRED", capability };
  }
  const availableScopes = new Set(scopes);
  if (policy.scopes.some((scope) => !availableScopes.has(scope))) {
    return { decision: "deny", reason: "MISSING_SCOPE", capability, requiredScopes: [...policy.scopes] };
  }
  if (policy.sensitive) {
    const stepUp = Date.parse(stepUpAt ?? "");
    if (!Number.isFinite(stepUp) || now - stepUp > stepUpWindowMs || stepUp > now) {
      return { decision: "step_up_required", reason: "STEP_UP_REQUIRED", capability };
    }
  }
  const auth = {
    subject,
    actorType,
    ...(organizationId ? { organizationId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    scopes: [...new Set(scopes)],
    roles: [...new Set(roles)],
  };
  return {
    decision: "allow",
    capability,
    context: createAuthorizationContext({ auth, resource: capability, action: "execute" }),
  };
}

export function assertCapabilityAuthorized(input) {
  const result = authorizeCapability(input);
  if (result.decision !== "allow") {
    const error = new Error(`Capability authorization failed: ${result.reason}`);
    error.code = result.reason;
    error.capability = input?.capability;
    throw error;
  }
  return result.context;
}

/**
 * Enforcement Roadmap Track H, Phase H4: the extracted-service half of
 * "make sure every domain adapter and every extracted-service route also
 * goes through the same policy engine". `@ayzen/service-runtime`'s
 * `createServiceServer` calls this for every request whose (method,
 * pathname) resolves to a registered capability, so all ~10 extracted
 * services (finance, vault, mail, ...) share this ONE gate instead of each
 * hand-rolling its own tenant/ownership check inline (finance.mjs's old
 * ad hoc `workspaceId` comparison being the example that prompted this).
 *
 * Scope, honestly stated: this decides identity + capability-registration
 * only — "is someone authenticated, and does this route require a scope at
 * all, and is it marked sensitive" — NOT a full scope/ABAC/ownership
 * decision. It cannot be more than that yet without either (a) giving these
 * deliberately DB-free services a database, which
 * packages/service-runtime/src/index.mjs's own header rules out, or (b) a
 * live call back into the monolith's DB-backed PolicyEngine/RBAC for every
 * request. Both are real options for a follow-up phase, not this one — see
 * CHANGES_ENFORCEMENT_ROADMAP_TRACK_H_PHASE_H4.md's "Not done" section for
 * why: AYZEN's session JWTs (lib/jwt.ts's signAuthToken) carry only
 * {userId, role}, no scopes claim, and the RBAC permission-key vocabulary
 * ("product.resource.action") has no declared mapping to this file's scope
 * vocabulary ("domain:action") today — inventing one here, un-reviewed,
 * risks silently over- or under-granting, which is worse than the gap this
 * phase actually closes (zero shared gate at all).
 *
 * `internalService: true` trusts a request already authenticated as a
 * verified service-to-service caller (service-runtime's
 * `createConfiguredAuthenticator`'s internal-secret branch) — that caller
 * already passed whatever policy check gated it upstream (the api-gateway,
 * or the monolith route it fronts); re-deriving a scope decision for it here
 * from nothing would be strictly less trustworthy, not more.
 */
export function authorizeServiceCapability({ method, pathname, auth, internalService = false } = {}) {
  const entry = matchCapabilityRoute(method, pathname);
  if (!entry) return { decision: "not_gated" };
  if (internalService) return { decision: "allow", capability: entry.capability, reason: "INTERNAL_SERVICE_TRUSTED" };
  const policy = CAPABILITY_POLICIES.get(entry.capability) ?? { scopes: entry.permission ? [entry.permission] : [], sensitive: Boolean(entry.sensitive) };
  if (policy.scopes.length === 0 && !policy.sensitive) return { decision: "allow", capability: entry.capability, reason: "NO_SCOPE_REQUIRED" };
  // Real AYZEN session tokens (lib/jwt.ts's signAuthToken) carry {userId,
  // role}, not a `sub`/`subject` claim, so any of the three identify an
  // authenticated caller here — see this function's header for why a scope
  // claim itself is not required yet.
  const identified = auth?.subject ?? auth?.sub ?? auth?.userId;
  if (identified === undefined || identified === null || (typeof identified === "string" && !identified.trim())) {
    return { decision: "deny", capability: entry.capability, reason: "AUTHENTICATED_SUBJECT_REQUIRED", requiredScopes: [...policy.scopes] };
  }
  return { decision: "allow", capability: entry.capability, reason: "IDENTITY_PRESENT_SCOPE_NOT_VERIFIED", requiredScopes: [...policy.scopes], sensitive: policy.sensitive };
}

export function assertTelegramCommandAuthorized({ command, botKey, ...input } = {}) {
  if (typeof command !== "string" || !command.startsWith("/")) throw new Error("Telegram command is required");
  const token = command.split(/\s+/)[0];
  const mapping = TELEGRAM_COMMAND_POLICIES_BY_BOT[botKey]?.[token] ?? TELEGRAM_COMMAND_POLICIES[token];
  if (!mapping) throw new Error(`Telegram command is not registered: ${command}`);
  if (botKey && mapping.bot && mapping.bot !== botKey) {
    const error = new Error("Telegram command is not registered for this bot");
    error.code = "TELEGRAM_COMMAND_BOT_MISMATCH";
    throw error;
  }
  return assertCapabilityAuthorized({ ...input, capability: mapping.capability });
}

export const TELEGRAM_COMMAND_POLICIES = Object.freeze({
  "/start": { bot: "ayzenx", capability: "identity.authenticate" },
  "/help": { bot: "ayzenx", capability: "identity.authenticate" },
  "/connect": { bot: "ayzenx", capability: "identity.authenticate" },
  "/workspace": { bot: "ayzenx", capability: "workspace.switch-context" },
  "/activity": { bot: "ayzenx", capability: "workspace.activity" },
  "/search": { bot: "ayzenx", capability: "search.search" },
  "/notifications": { bot: "ayzenx", capability: "notification.list-notifications" },
  "/settings": { bot: "ayzenx", capability: "workspace.get-workspace" },
  "/permissions": { bot: "ayzenx", capability: "workspace.get-workspace" },
  "/report": { bot: "warde", capability: "organization.report" },
  "/members": { bot: "warde", capability: "workspace.list-members" },
  "/invite": { bot: "warde", capability: "workspace.add-member" },
  "/listings": { bot: "verve", capability: "marketplace.list" },
  "/listing": { bot: "verve", capability: "marketplace.create-listing" },
  "/accounts": { bot: "ryft", capability: "finance.list-accounts" },
  "/balance": { bot: "ryft", capability: "finance.get-balance" },
  "/transactions": { bot: "ryft", capability: "finance.list-accounts" },
  "/transaction": { bot: "ryft", capability: "finance.post-transaction" },
  "/vault": { bot: "sylo", capability: "vault.list-secrets" },
  "/secret": { bot: "sylo", capability: "vault.create-secret" },
  "/reveal": { bot: "sylo", capability: "vault.read-secret" },
  "/project": { bot: "skarn", capability: "workspace.get-workspace" },
  "/workflow": { bot: "skarn", capability: "workflow.get-execution" },
  "/run": { bot: "skarn", capability: "workflow.start-execution" },
  "/cancel": { bot: "skarn", capability: "workflow.cancel-execution" },
  "/tasks": { bot: "skarn", capability: "workflow.get-execution" },
  "/events": { bot: "skarn", capability: "workspace.activity" },
  "/audit": { bot: "skarn", capability: "workspace.activity" },
  "/ask": { bot: "zynth", capability: "ai.run-agent" },
  "/agents": { bot: "zynth", capability: "ai.run-agent" },
  "/history": { bot: "zynth", capability: "ai.run-agent" },
  "/inbox": { bot: "wisp", capability: "mail.list-messages" },
  "/read": { bot: "wisp", capability: "mail.read-thread" },
  "/send": { bot: "wisp", capability: "mail.send-message" },
  "/admin": { bot: "admin", capability: "admin.read" },
  "/health": { bot: "admin", capability: "admin.read" },
  "/alerts": { bot: "admin", capability: "admin.read" },
  "/gaps": { bot: "admin", capability: "admin.read" },
  "/tickets": { bot: "admin", capability: "admin.read" },
  "/data": { bot: "admin", capability: "admin.data-read" },
  "/mutate": { bot: "admin", capability: "admin.data-write" },
  "/breakglass": { bot: "admin", capability: "admin.break-glass" },
  "/incident": { bot: "admin", capability: "admin.remediate" },
  "/ack": { bot: "admin", capability: "admin.remediate" },
  "/resolve": { bot: "admin", capability: "admin.remediate" },
  "/deploy": { bot: "admin", capability: "admin.deploy" },
});

const botCommand = (bot, entries) => Object.freeze(Object.fromEntries(entries.map(([command, capability]) => [command, { bot, capability }])));
export const TELEGRAM_COMMAND_POLICIES_BY_BOT = Object.freeze({
  ayzenx: botCommand("ayzenx", [
    ["/start", "identity.authenticate"], ["/help", "identity.authenticate"], ["/connect", "identity.authenticate"],
    ["/workspace", "workspace.switch-context"], ["/activity", "workspace.activity"], ["/search", "search.search"],
    ["/notifications", "notification.list-notifications"], ["/settings", "workspace.get-workspace"], ["/permissions", "workspace.get-workspace"],
  ]),
  warde: botCommand("warde", [
    ["/start", "identity.authenticate"], ["/help", "identity.authenticate"], ["/report", "organization.report"],
    ["/members", "workspace.list-members"], ["/invite", "workspace.add-member"], ["/activity", "workspace.activity"], ["/settings", "workspace.get-workspace"],
  ]),
  verve: botCommand("verve", [
    ["/start", "identity.authenticate"], ["/help", "identity.authenticate"], ["/listings", "marketplace.list"],
    ["/listing", "marketplace.create-listing"], ["/search", "search.search"], ["/activity", "workspace.activity"],
  ]),
  ryft: botCommand("ryft", [
    ["/start", "identity.authenticate"], ["/help", "identity.authenticate"], ["/accounts", "finance.list-accounts"],
    ["/balance", "finance.get-balance"], ["/transactions", "finance.list-accounts"], ["/transaction", "finance.post-transaction"], ["/activity", "workspace.activity"],
  ]),
  sylo: botCommand("sylo", [
    ["/start", "identity.authenticate"], ["/help", "identity.authenticate"], ["/vault", "vault.list-secrets"],
    ["/secret", "vault.create-secret"], ["/reveal", "vault.read-secret"], ["/activity", "workspace.activity"],
  ]),
  skarn: botCommand("skarn", [
    ["/start", "identity.authenticate"], ["/help", "identity.authenticate"], ["/project", "workspace.get-workspace"],
    ["/workflow", "workflow.get-execution"], ["/run", "workflow.start-execution"], ["/cancel", "workflow.cancel-execution"],
    ["/tasks", "workflow.get-execution"], ["/events", "workspace.activity"], ["/audit", "workspace.activity"],
  ]),
  zynth: botCommand("zynth", [
    ["/start", "identity.authenticate"], ["/help", "identity.authenticate"], ["/ask", "ai.run-agent"],
    ["/agents", "ai.run-agent"], ["/history", "ai.run-agent"], ["/activity", "workspace.activity"],
  ]),
  wisp: botCommand("wisp", [
    ["/start", "identity.authenticate"], ["/help", "identity.authenticate"], ["/inbox", "mail.list-messages"],
    ["/read", "mail.read-thread"], ["/send", "mail.send-message"], ["/search", "mail.search"], ["/notifications", "notification.list-notifications"],
  ]),
  admin: botCommand("admin", [
    ["/start", "identity.authenticate"], ["/help", "admin.read"], ["/admin", "admin.read"], ["/health", "admin.read"],
    ["/alerts", "admin.read"], ["/gaps", "admin.read"], ["/tickets", "admin.read"], ["/audit", "admin.audit"],
    ["/data", "admin.data-read"], ["/mutate", "admin.data-write"], ["/breakglass", "admin.break-glass"],
    ["/incident", "admin.remediate"], ["/ack", "admin.remediate"], ["/resolve", "admin.remediate"], ["/deploy", "admin.deploy"],
  ]),
});

export const APP_POLICY_PACKS = Object.freeze({
  ayzenx: Object.freeze({ version: 1, roles: ["member", "owner"], defaultDeny: true, sensitiveRequiresStepUp: true }),
  warde: Object.freeze({ version: 1, roles: ["member", "manager", "owner"], defaultDeny: true, sensitiveRequiresStepUp: true }),
  verve: Object.freeze({ version: 1, roles: ["member", "owner"], defaultDeny: true, sensitiveRequiresStepUp: true }),
  ryft: Object.freeze({ version: 1, roles: ["viewer", "operator", "owner"], defaultDeny: true, sensitiveRequiresStepUp: true }),
  sylo: Object.freeze({ version: 1, roles: ["viewer", "operator", "owner"], defaultDeny: true, sensitiveRequiresStepUp: true }),
  skarn: Object.freeze({ version: 1, roles: ["viewer", "operator", "owner"], defaultDeny: true, sensitiveRequiresStepUp: true }),
  zynth: Object.freeze({ version: 1, roles: ["user", "operator", "owner"], defaultDeny: true, sensitiveRequiresStepUp: true }),
  wisp: Object.freeze({ version: 1, roles: ["member", "operator", "owner"], defaultDeny: true, sensitiveRequiresStepUp: true }),
  admin: Object.freeze({ version: 1, roles: ["owner", "operator", "auditor"], defaultDeny: true, sensitiveRequiresStepUp: true }),
});

export function evaluatePolicyPack({ app, role, action, requiredRole } = {}) {
  const pack = APP_POLICY_PACKS[app];
  if (!pack) return { decision: "deny", reason: "UNKNOWN_APP" };
  if (!pack.roles.includes(role)) return { decision: "deny", reason: "ROLE_NOT_ALLOWED", app, action };
  if (requiredRole && role !== requiredRole && role !== "owner") return { decision: "deny", reason: "INSUFFICIENT_ROLE", app, action };
  return { decision: "allow", app, action, policyVersion: pack.version };
}