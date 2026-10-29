import crypto from "node:crypto";

const BREAK_GLASS_TTL_MS = 15 * 60 * 1000;

function scopesFrom(auth) {
  return new Set([...(auth?.scopes ?? []), ...(typeof auth?.scope === "string" ? auth.scope.split(/\s+/) : [])]);
}

export function authorizeAdminAction({ auth, scope, reason, confirmation = false, breakGlass = false } = {}) {
  if (!scope || !scopesFrom(auth).has(scope)) return { allowed: false, code: "ADMIN_SCOPE_REQUIRED", scope };
  if (breakGlass && (!reason || String(reason).trim().length < 12 || confirmation !== true)) {
    return { allowed: false, code: "BREAK_GLASS_REASON_AND_CONFIRMATION_REQUIRED" };
  }
  return { allowed: true, scope, elevated: breakGlass };
}

export function createBreakGlassManager({ ttlMs = BREAK_GLASS_TTL_MS, now = () => Date.now() } = {}) {
  const grants = new Map();
  function prune() {
    const current = now();
    for (const [id, grant] of grants) if (grant.expiresAt <= current || grant.used) grants.delete(id);
  }
  return Object.freeze({
    issue({ actor, reason, confirmation = false, scope = "admin:break-glass" } = {}) {
      prune();
      if (!actor?.subject || typeof reason !== "string" || reason.trim().length < 12 || confirmation !== true) {
        const error = new Error("Break-glass requires an actor, reason, and explicit confirmation");
        error.code = "BREAK_GLASS_REASON_AND_CONFIRMATION_REQUIRED";
        throw error;
      }
      const id = crypto.randomUUID();
      const grant = { id, actor: actor.subject, scope, reason: reason.trim().slice(0, 500), issuedAt: now(), expiresAt: now() + ttlMs, used: false };
      grants.set(id, grant);
      return Object.freeze({ ...grant });
    },
    consume({ id, actor, scope } = {}) {
      prune();
      const grant = grants.get(id);
      if (!grant || grant.actor !== actor?.subject || (scope && grant.scope !== scope)) return { valid: false, code: "BREAK_GLASS_INVALID_OR_EXPIRED" };
      grant.used = true;
      grants.delete(id);
      return { valid: true, grant: Object.freeze({ ...grant }) };
    },
    revoke(id) {
      return grants.delete(id);
    },
    listActive() {
      prune();
      return [...grants.values()].map((grant) => Object.freeze({ ...grant, used: false }));
    },
  });
}