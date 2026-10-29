import crypto from "node:crypto";

export const IDENTITY_TYPES = Object.freeze([
  "ayzen",
  "local-app",
  "connected-app",
]);

export const ACCOUNT_STATES = Object.freeze([
  "pending_verification",
  "active",
  "disabled",
  "recovery_required",
]);

export const LINK_STATES = Object.freeze(["active", "revoked"]);

export const IDENTITY_EVENT_TYPES = Object.freeze([
  "identity.local.created",
  "identity.local.verified",
  "identity.local.disabled",
  "identity.local.recovery_required",
  "identity.ayzen.verified",
  "identity.link.created",
  "identity.link.revoked",
  "identity.session.created",
  "identity.session.revoked",
  "identity.profile.synced",
  "identity.security.failure",
]);

const TRANSITIONS = Object.freeze({
  pending_verification: new Set(["active", "disabled", "recovery_required"]),
  active: new Set(["disabled", "recovery_required"]),
  recovery_required: new Set(["active", "disabled"]),
  disabled: new Set(["recovery_required"]),
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function identifier(value, label) {
  const result = requiredString(value, label);
  if (!/^[A-Za-z0-9._:@/-]{1,256}$/.test(result)) throw new Error(`${label} is invalid`);
  return result;
}

function privacySafeActor(actor) {
  return actor ? { type: actor.type ?? "user", id: String(actor.id ?? "unknown") } : undefined;
}

function event(type, payload, actor, now) {
  return {
    id: crypto.randomUUID(),
    type,
    occurredAt: new Date(now()).toISOString(),
    actor: privacySafeActor(actor),
    payload,
  };
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createHybridIdentityRegistry({ now = () => Date.now() } = {}) {
  const locals = new Map();
  const ayzen = new Map();
  const links = new Map();
  const sessions = new Map();
  const audit = [];

  function emit(type, payload, actor) {
    if (!IDENTITY_EVENT_TYPES.includes(type)) throw new Error(`Identity event is not registered: ${type}`);
    const record = event(type, payload, actor, now);
    audit.push(record);
    return clone(record);
  }

  function localIdentity(id) {
    const identity = locals.get(id);
    if (!identity) throw new Error("Local app identity is not registered");
    return identity;
  }

  function ayzenIdentity(id) {
    const identity = ayzen.get(id);
    if (!identity) throw new Error("AYZEN identity is not registered");
    return identity;
  }

  function activeLink(appId, ayzenIdentityId) {
    return [...links.values()].find(
      (link) => link.appId === appId && link.ayzenIdentityId === ayzenIdentityId && link.state === "active",
    );
  }

  function createLocalAccount({ appId, ownerId, profile = {} } = {}) {
    const localId = `local:${crypto.randomUUID()}`;
    const account = {
      id: localId,
      type: "local-app",
      appId: identifier(appId, "App id"),
      ownerId: requiredString(ownerId, "Owner id"),
      state: "pending_verification",
      profile: clone(profile),
      createdAt: new Date(now()).toISOString(),
    };
    locals.set(localId, account);
    emit("identity.local.created", { appId: account.appId, identityId: localId }, { type: "user", id: ownerId });
    return clone(account);
  }

  function transitionLocalAccount(identityId, targetState, actor) {
    const account = localIdentity(identityId);
    if (!ACCOUNT_STATES.includes(targetState)) throw new Error(`Unknown account state: ${targetState}`);
    if (account.state !== targetState && !TRANSITIONS[account.state]?.has(targetState)) {
      throw new Error(`Invalid account transition: ${account.state} -> ${targetState}`);
    }
    account.state = targetState;
    const eventType = targetState === "active"
      ? "identity.local.verified"
      : targetState === "disabled"
        ? "identity.local.disabled"
        : targetState === "recovery_required"
          ? "identity.local.recovery_required"
          : null;
    if (eventType) emit(eventType, { appId: account.appId, identityId }, actor);
    return clone(account);
  }

  function registerVerifiedAyzenIdentity({ issuer, subject, claims = {} } = {}) {
    const normalizedIssuer = requiredString(issuer, "AYZEN issuer");
    const normalizedSubject = requiredString(subject, "AYZEN subject");
    const id = `ayzen:${digest(`${normalizedIssuer}|${normalizedSubject}`).slice(0, 32)}`;
    const identity = {
      id,
      type: "ayzen",
      issuer: normalizedIssuer,
      subject: normalizedSubject,
      claims: clone(claims),
      verifiedAt: new Date(now()).toISOString(),
    };
    ayzen.set(id, identity);
    emit("identity.ayzen.verified", { identityId: id, issuer: normalizedIssuer }, { type: "ayzen", id });
    return clone(identity);
  }

  function resolveAccount({ appId, ayzenIdentityId, localIdentityId } = {}) {
    const normalizedApp = identifier(appId, "App id");
    if (ayzenIdentityId) ayzenIdentity(ayzenIdentityId);
    if (localIdentityId) {
      const local = localIdentity(localIdentityId);
      if (local.appId !== normalizedApp) throw new Error("Local identity belongs to another app");
    }
    if (ayzenIdentityId) {
      const link = activeLink(normalizedApp, ayzenIdentityId);
      if (link) return { outcome: "connected", identityId: link.localIdentityId, linkId: link.id };
    }
    if (localIdentityId && ayzenIdentityId) {
      return { outcome: "explicit_link_required", identityId: localIdentityId, ayzenIdentityId };
    }
    if (localIdentityId) return { outcome: "local", identityId: localIdentityId };
    return { outcome: "offer_connect_or_create_local", appId: normalizedApp };
  }

  function createIdentityLink({ appId, localIdentityId, ayzenIdentityId, confirmation = false, actor } = {}) {
    const normalizedApp = identifier(appId, "App id");
    const local = localIdentity(localIdentityId);
    const central = ayzenIdentity(ayzenIdentityId);
    if (local.appId !== normalizedApp) throw new Error("Local identity belongs to another app");
    if (local.state !== "active") throw new Error("Local identity must be active before linking");
    if (!central.verifiedAt) throw new Error("Verified AYZEN identity is required");
    if (confirmation !== true) throw new Error("Explicit link confirmation is required");
    if (activeLink(normalizedApp, ayzenIdentityId)) throw new Error("AYZEN identity is already linked to this app");
    const existingForLocal = [...links.values()].find(
      (link) => link.appId === normalizedApp && link.localIdentityId === localIdentityId && link.state === "active",
    );
    if (existingForLocal) throw new Error("Local identity already has an active AYZEN link");
    const link = {
      id: `link:${crypto.randomUUID()}`,
      appId: normalizedApp,
      localIdentityId,
      ayzenIdentityId,
      state: "active",
      createdAt: new Date(now()).toISOString(),
    };
    links.set(link.id, link);
    emit("identity.link.created", { appId: normalizedApp, linkId: link.id, localIdentityId, ayzenIdentityId }, actor);
    return clone(link);
  }

  function revokeIdentityLink(linkId, { confirmation = false, actor } = {}) {
    const link = links.get(linkId);
    if (!link) throw new Error("Identity link is not registered");
    if (confirmation !== true) throw new Error("Explicit unlink confirmation is required");
    if (link.state === "revoked") return clone(link);
    link.state = "revoked";
    link.revokedAt = new Date(now()).toISOString();
    emit("identity.link.revoked", { appId: link.appId, linkId, localIdentityId: link.localIdentityId, ayzenIdentityId: link.ayzenIdentityId }, actor);
    return clone(link);
  }

  function updateLocalProfile({ identityId, fields = {}, actor } = {}) {
    const local = localIdentity(identityId);
    for (const [key, value] of Object.entries(fields)) local.profile[key] = clone(value);
    return clone(local.profile);
  }

  function syncApprovedProfile({ identityId, claims = {}, mappings = {}, consent = false, actor } = {}) {
    const local = localIdentity(identityId);
    if (consent !== true) throw new Error("Profile sync consent is required");
    const changed = [];
    for (const [claim, mapping] of Object.entries(mappings)) {
      if (!mapping || mapping.source !== "ayzen" || mapping.authoritative !== true) continue;
      if (mapping.appOwned === true) continue;
      if (!Object.prototype.hasOwnProperty.call(claims, claim)) continue;
      local.profile[mapping.field] = clone(claims[claim]);
      changed.push(mapping.field);
    }
    emit("identity.profile.synced", { appId: local.appId, identityId, fields: changed }, actor);
    return { identityId, fields: changed, profile: clone(local.profile) };
  }

  function createSession({ appId, identityId, token, deviceId, ttlMs = 30 * 60 * 1000 } = {}) {
    const local = localIdentity(identityId);
    if (local.appId !== identifier(appId, "App id")) throw new Error("Session app does not own identity");
    if (local.state !== "active") throw new Error("Active identity is required for a session");
    const tokenDigest = digest(requiredString(token, "Session token"));
    const session = {
      id: `session:${crypto.randomUUID()}`,
      appId: local.appId,
      identityId,
      deviceId: requiredString(deviceId, "Device id"),
      tokenDigest,
      createdAt: now(),
      expiresAt: now() + ttlMs,
      revokedAt: null,
    };
    sessions.set(session.id, session);
    emit("identity.session.created", { appId: local.appId, identityId, sessionId: session.id, deviceId: session.deviceId });
    return { ...clone(session), tokenDigest: undefined };
  }

  function assertSession({ sessionId, appId, token, at = now() } = {}) {
    const session = sessions.get(sessionId);
    if (!session || session.appId !== identifier(appId, "App id") || session.revokedAt || session.expiresAt <= at) {
      throw new Error("Session is expired, revoked, or app-scoped incorrectly");
    }
    if (!constantTimeEqual(session.tokenDigest, digest(requiredString(token, "Session token")))) {
      throw new Error("Session token is invalid");
    }
    return { sessionId, appId: session.appId, identityId: session.identityId, deviceId: session.deviceId };
  }

  function revokeSession(sessionId, actor) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error("Session is not registered");
    session.revokedAt = now();
    emit("identity.session.revoked", { appId: session.appId, identityId: session.identityId, sessionId }, actor);
    return clone(session);
  }

  function revokeAllSessions(identityId, actor) {
    const revoked = [];
    for (const session of sessions.values()) {
      if (session.identityId === identityId && !session.revokedAt) revoked.push(revokeSession(session.id, actor).id);
    }
    return revoked;
  }

  return Object.freeze({
    createLocalAccount,
    transitionLocalAccount,
    registerVerifiedAyzenIdentity,
    resolveAccount,
    createIdentityLink,
    revokeIdentityLink,
    updateLocalProfile,
    syncApprovedProfile,
    createSession,
    assertSession,
    revokeSession,
    revokeAllSessions,
    getLocalAccount: (id) => clone(localIdentity(id)),
    getAyzenIdentity: (id) => clone(ayzenIdentity(id)),
    listLinks: () => [...links.values()].map(clone),
    listAudit: () => audit.map(clone),
    snapshot: () => clone({
      localAccounts: [...locals.values()],
      ayzenIdentities: [...ayzen.values()],
      links: [...links.values()],
      sessions: [...sessions.values()].map(({ tokenDigest, ...safe }) => safe),
      audit,
    }),
  });
}