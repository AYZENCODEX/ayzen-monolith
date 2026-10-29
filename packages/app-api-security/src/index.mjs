import crypto from "node:crypto";

const ID = /^[A-Za-z0-9._:@/-]{1,256}$/;

function valid(value, label) {
  if (typeof value !== "string" || !value.trim() || !ID.test(value.trim())) throw new Error(`${label} is required`);
  return value.trim();
}

function scopesFor(policy, app, capability) {
  const appPolicy = policy?.apps?.[app];
  const capabilityPolicy = appPolicy?.capabilities?.[capability];
  if (!appPolicy || !capabilityPolicy || appPolicy.defaultDeny !== true) return null;
  return capabilityPolicy;
}

export function createAppSecurityContext({ app, principal, tenant, request, service } = {}) {
  const normalizedApp = valid(app, "App");
  if (!principal?.subject) throw new Error("Authenticated principal is required");
  if (!tenant?.organizationId && !tenant?.workspaceId) throw new Error("Tenant context is required");
  if (!request?.requestId || !request.traceId || !request.correlationId) throw new Error("Request trace context is required");
  return Object.freeze({ app: normalizedApp, principal, tenant, request, ...(service ? { service: valid(service, "Service") } : {}) });
}

export function authorizeAppRequest({ context, capability, targetApp = context?.app, action = "execute", policy } = {}) {
  if (!context || targetApp !== context.app) return { decision: "deny", code: "APP_CONTEXT_MISMATCH" };
  const requirement = scopesFor(policy, targetApp, capability);
  if (!requirement) return { decision: "deny", code: "CAPABILITY_NOT_REGISTERED" };
  const scopes = new Set(context.principal.scopes ?? []);
  const roles = new Set(context.principal.roles ?? []);
  if (requirement.roles?.length && !requirement.roles.some((role) => roles.has(role))) return { decision: "deny", code: "ROLE_REQUIRED" };
  if ((requirement.scopes ?? []).some((scope) => !scopes.has(scope))) return { decision: "deny", code: "SCOPE_REQUIRED", requiredScopes: requirement.scopes };
  if (requirement.stepUp === true && context.principal.stepUp !== true) return { decision: "deny", code: "STEP_UP_REQUIRED" };
  return { decision: "allow", app: targetApp, capability, action, policyVersion: policy.version ?? 1 };
}

export function signSecurityMetadata({ app, requestId, bodyHash, secret } = {}) {
  valid(app, "App");
  valid(requestId, "Request id");
  if (typeof bodyHash !== "string" || !bodyHash) throw new Error("Body hash is required");
  if (typeof secret !== "string" || !secret) throw new Error("Signing secret is required");
  return crypto.createHmac("sha256", secret).update(`${app}.${requestId}.${bodyHash}`).digest("hex");
}

export function verifySecurityMetadata(input = {}) {
  try {
    const expected = signSecurityMetadata(input);
    const actual = Buffer.from(String(input.signature ?? ""), "hex");
    const wanted = Buffer.from(expected, "hex");
    return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
  } catch {
    return false;
  }
}

export function createSecurityKernel({ policy, authenticate } = {}) {
  if (!policy || typeof authenticate !== "function") throw new Error("Security policy and authenticator are required");
  return Object.freeze({
    async authenticate(request) {
      const principal = await authenticate(request);
      if (!principal) throw new Error("Authentication failed");
      return principal;
    },
    authorize(input) {
      return authorizeAppRequest({ ...input, policy });
    },
  });
}