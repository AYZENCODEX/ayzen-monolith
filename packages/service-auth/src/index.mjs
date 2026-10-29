import crypto from "node:crypto";

export function createServicePolicy({ service, audience, scopes = [], allowedTargets = [], sensitive = false } = {}) {
  if (typeof service !== "string" || !service || typeof audience !== "string" || !audience) throw new Error("Service and audience are required");
  return Object.freeze({ service, audience, scopes: [...new Set(scopes)], allowedTargets: [...new Set(allowedTargets)], sensitive });
}

export function authorizeServiceCall({ policy, caller, target, scope, audience, stepUp = false } = {}) {
  if (!policy || caller !== policy.service || audience !== policy.audience) return { decision: "deny", code: "SERVICE_IDENTITY_INVALID" };
  if (!policy.allowedTargets.includes(target)) return { decision: "deny", code: "TARGET_NOT_ALLOWED" };
  if (scope && !policy.scopes.includes(scope)) return { decision: "deny", code: "SCOPE_NOT_ALLOWED" };
  if (policy.sensitive && stepUp !== true) return { decision: "deny", code: "STEP_UP_REQUIRED" };
  return { decision: "allow", caller, target, audience };
}

export function signServiceCall({ caller, target, audience, requestId, bodyHash, secret } = {}) {
  if (![caller, target, audience, requestId, bodyHash, secret].every((value) => typeof value === "string" && value)) throw new Error("Service signing fields are required");
  return crypto.createHmac("sha256", secret).update(`${caller}.${target}.${audience}.${requestId}.${bodyHash}`).digest("hex");
}