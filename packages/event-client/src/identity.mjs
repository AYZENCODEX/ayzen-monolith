import { hashRequestBody, signServiceRequest, verifyServiceSignature } from "@ayzen/auth-client";

function eventSecurityContext(envelope) {
  return {
    eventType: envelope?.eventType ?? envelope?.type,
    version: envelope?.version ?? envelope?.metadata?.version ?? 1,
    organizationId: envelope?.organizationId,
    workspaceId: envelope?.workspaceId,
    aggregate: envelope?.aggregate,
    audience: envelope?.metadata?.audience,
    timestamp: envelope?.timestamp,
    payloadHash: hashRequestBody(envelope?.payload),
  };
}

/**
 * Phase H10.1 — `config/eventbus/security.json` names the identity
 * mechanism for both `producerIdentity` and `consumerIdentity` as
 * `"service-auth"`. That label refers to the service-to-service identity
 * concept already deployed across every service in this repo, not
 * literally to `@ayzen/service-auth`'s caller/target/scope *policy*
 * engine (that package has no `allowedTargets` routing configured
 * anywhere yet — wiring that up is a bus-routing concern, H10.3's job,
 * not this one). The actual HMAC primitives behind that identity concept
 * already live in `@ayzen/auth-client` (`signServiceRequest` /
 * `verifyServiceSignature`) and are already the exact mechanism
 * `service-runtime`'s `createConfiguredAuthenticator` uses to trust an
 * internal service-to-service HTTP caller via `AYZEN_SERVICE_AUTH_SECRET`
 * (see that file's `verifyServiceRequestHeaders` call). Reusing them here
 * means a secret already deployed for that HTTP path also proves identity
 * on the event bus, instead of standing up a second, parallel secret.
 */
export function resolveEventBusSecret() {
  return process.env.AYZEN_SERVICE_AUTH_SECRET ?? process.env.SERVICE_TO_SERVICE_SECRET;
}

/**
 * Stamps a verifiable producer attestation onto an envelope's metadata.
 * Idempotent-ish: if no secret is configured, this is a deliberate no-op
 * (the unsigned `metadata.producer` label callers already set stays as
 * the only claim) — enforcement, not signing, is what decides whether an
 * unsigned publish is allowed through; see `enforceProducerIdentity`.
 */
export function attachProducerIdentity(envelope, { service, secret = resolveEventBusSecret() } = {}) {
  if (!service || !secret) return envelope;
  const timestamp = String(Date.now());
  const bodyHash = hashRequestBody(eventSecurityContext(envelope));
  const signature = signServiceRequest({ service, timestamp, requestId: envelope.eventId, bodyHash, audience: envelope.metadata?.audience ?? envelope.eventType, secret });
  return {
    ...envelope,
    metadata: {
      ...(envelope.metadata ?? {}),
      producer: envelope.metadata?.producer ?? service,
      producerIdentity: { service, timestamp, signature },
    },
  };
}

/**
 * Verifies a producer attestation previously stamped by
 * `attachProducerIdentity`. Returns a decision object rather than
 * throwing so callers can log and choose enforce/report/off behavior
 * themselves (mirroring H9.2's own gate-decision shape).
 */
export function verifyProducerIdentity(envelope, { secret = resolveEventBusSecret(), maxClockSkewMs } = {}) {
  if (!secret) return { valid: false, reason: "EVENT_BUS_SECRET_NOT_CONFIGURED" };
  const identity = envelope?.metadata?.producerIdentity;
  if (!identity || typeof identity.service !== "string" || !identity.service) {
    return { valid: false, reason: "PRODUCER_IDENTITY_MISSING" };
  }
  const bodyHash = hashRequestBody(eventSecurityContext(envelope));
  const ok = verifyServiceSignature({
    service: identity.service,
    timestamp: identity.timestamp,
    requestId: envelope.eventId ?? envelope.id,
    bodyHash,
    audience: envelope.metadata?.audience ?? envelope.eventType,
    signature: identity.signature,
    secret,
    ...(maxClockSkewMs !== undefined ? { maxClockSkewMs } : {}),
  });
  return ok
    ? { valid: true, service: identity.service }
    : { valid: false, reason: "PRODUCER_IDENTITY_INVALID" };
}

/**
 * Signs a consumer's claimed identity for a given event type. There's no
 * per-message body to bind this to (subscribing is a local handler
 * registration, not a single request/response), so the signed payload is
 * just "this service, at this time, claims to consume this type" — enough
 * to prove possession of the shared secret and catch a
 * misconfigured/spoofed `SERVICE_NAME`, which is what `consumerIdentity`
 * in the config is asking for.
 */
export function signConsumerIdentity({ service, eventType, secret = resolveEventBusSecret() } = {}) {
  if (!service || !secret) return undefined;
  const timestamp = String(Date.now());
  const bodyHash = hashRequestBody({ eventType, audience: eventType });
  const signature = signServiceRequest({ service, timestamp, requestId: `subscribe:${eventType}`, bodyHash, audience: eventType, secret });
  return { service, timestamp, signature };
}

export function verifyConsumerIdentity({ identity, eventType, secret = resolveEventBusSecret(), maxClockSkewMs } = {}) {
  if (!secret) return { valid: false, reason: "EVENT_BUS_SECRET_NOT_CONFIGURED" };
  if (!identity || typeof identity.service !== "string" || !identity.service) {
    return { valid: false, reason: "CONSUMER_IDENTITY_MISSING" };
  }
  const bodyHash = hashRequestBody({ eventType, audience: eventType });
  const ok = verifyServiceSignature({
    service: identity.service,
    timestamp: identity.timestamp,
    requestId: `subscribe:${eventType}`,
    bodyHash,
    audience: eventType,
    signature: identity.signature,
    secret,
    ...(maxClockSkewMs !== undefined ? { maxClockSkewMs } : {}),
  });
  return ok
    ? { valid: true, service: identity.service }
    : { valid: false, reason: "CONSUMER_IDENTITY_INVALID" };
}

/**
 * Shared enforce/report/off gate, mirroring `service-runtime`'s
 * `SERVICE_CAPABILITY_GATE` / `CAPABILITY_AUTHZ_GATE` pattern (H9.1/H9.2)
 * so every enforcement point in this repo reads the same three states the
 * same way.
 *
 * This gate's safe default is "report", not "enforce" — for the same
 * reason `CAPABILITY_AUTHZ_GATE` (H9.2) had to be "report": nothing in a
 * real deployment is guaranteed to actually have
 * `AYZEN_SERVICE_AUTH_SECRET` configured today (`service-runtime`'s own
 * `createConfiguredAuthenticator` treats it as optional, falling back to
 * "no internal secret" happily), so defaulting to "enforce" would deny
 * every publish and subscribe call in any environment that hasn't set it
 * yet — not just the bad ones. (An earlier version of this gate defaulted
 * to "enforce" on the theory that the secret was already universally
 * deployed for HTTP calls; running the existing Redis chaos test suite
 * against a real broker immediately falsified that — both tests failed
 * with `EVENT_BUS_SECRET_NOT_CONFIGURED` — which is exactly the signal
 * this default exists to avoid.) An unset or typo'd env value fails
 * toward "report", the safe direction, matching `CAPABILITY_AUTHZ_GATE`'s
 * own fail-toward-report reasoning exactly.
 *
 * `policy.defaultDeny` (from `config/eventbus/security.json`) still means
 * something here even though it can't safely drive the *default*: an
 * operator who explicitly sets `defaultDeny: false` in the config is
 * declaring "we don't want this checked at all", so that value turns the
 * gate fully "off" regardless of the env var default — an explicit config
 * opt-out is honored, just not treated as license to default to the
 * risky "enforce" state.
 */
export function eventBusIdentityGateMode(policy) {
  const raw = (process.env.EVENT_BUS_IDENTITY_GATE ?? "").toLowerCase();
  if (raw === "off" || raw === "report" || raw === "enforce") return raw;
  if (["production", "staging"].includes(String(process.env.NODE_ENV ?? "").toLowerCase())) return "enforce";
  return policy?.defaultDeny === false ? "off" : "report";
}
