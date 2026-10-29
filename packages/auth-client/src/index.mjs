import crypto from "node:crypto";

function decode(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

export function extractBearerToken(header) {
  const match = typeof header === "string" ? header.match(/^Bearer\s+([A-Za-z0-9._~-]+)$/i) : null;
  return match?.[1];
}

export function verifyRs256Jwt(token, { publicKey, issuer, audience, now = Date.now() } = {}) {
  if (typeof token !== "string" || typeof publicKey !== "string") throw new Error("JWT token and public key are required");
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) throw new Error("Malformed JWT");
  const header = decode(encodedHeader);
  const payload = decode(encodedPayload);
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("JWT algorithm or key ID is invalid");
  if (issuer && payload.iss !== issuer) throw new Error("JWT issuer is invalid");
  if (audience && !((Array.isArray(payload.aud) && payload.aud.includes(audience)) || payload.aud === audience)) throw new Error("JWT audience is invalid");
  const nowSeconds = Math.floor(now / 1000);
  if (!Number.isSafeInteger(payload.exp) || payload.exp <= nowSeconds) throw new Error("JWT is expired");
  if (payload.nbf !== undefined && (!Number.isSafeInteger(payload.nbf) || payload.nbf > nowSeconds)) throw new Error("JWT is not active");
  const valid = crypto.verify("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedPayload}`), publicKey, Buffer.from(encodedSignature, "base64url"));
  if (!valid) throw new Error("JWT signature is invalid");
  return payload;
}

export function assertAuthorizationContext(context, { organizationId, workspaceId, requiredScopes = [] } = {}) {
  if (!context || typeof context.subject !== "string") throw new Error("Authenticated actor is required");
  if (organizationId && context.organizationId !== organizationId) throw new Error("Organization authorization failed");
  if (workspaceId && context.workspaceId !== workspaceId) throw new Error("Workspace authorization failed");
  const scopes = new Set(context.scopes ?? []);
  if (requiredScopes.some((scope) => !scopes.has(scope))) throw new Error("Required authorization scope is missing");
  return context;
}

function publicKeyFromJwk(jwk) {
  if (!jwk || jwk.kty !== "RSA" || jwk.n === undefined || jwk.e === undefined) throw new Error("Unsupported JWKS key");
  return crypto.createPublicKey({ key: jwk, format: "jwk" });
}

export function createJwksAuthenticator({ jwksUrl, issuer, audience, cacheTtlMs = 300_000, fetchImpl = fetch } = {}) {
  if (typeof jwksUrl !== "string" || !jwksUrl) throw new Error("JWKS URL is required");
  const keys = new Map();
  let fetchedAt = 0;
  async function getKey(kid) {
    if (Date.now() - fetchedAt > cacheTtlMs || !keys.has(kid)) {
      const response = await fetchImpl(jwksUrl, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`JWKS request failed with ${response.status}`);
      const body = await response.json();
      if (!Array.isArray(body?.keys)) throw new Error("JWKS response is invalid");
      keys.clear();
      for (const jwk of body.keys) if (jwk.kid) keys.set(jwk.kid, publicKeyFromJwk(jwk));
      fetchedAt = Date.now();
    }
    const key = keys.get(kid);
    if (!key) throw new Error("JWT key ID is not available");
    return key;
  }
  return async function authenticateBearer(header) {
    const token = extractBearerToken(header);
    if (!token) throw new Error("Bearer token is required");
    const [encodedHeader] = token.split(".");
    const headerPayload = decode(encodedHeader);
    const publicKey = await getKey(headerPayload.kid);
    return verifyRs256Jwt(token, { publicKey, issuer, audience });
  };
}

export function createServiceIdentity({ service, audience = "ayzen-internal", scopes = [] } = {}) {
  if (typeof service !== "string" || !service.trim()) throw new Error("Service identity is required");
  return Object.freeze({
    subject: `service:${service.trim()}`,
    actorType: "service",
    audience,
    scopes: Object.freeze([...new Set(scopes)]),
  });
}

export function stableSerialize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
}

export function hashRequestBody(body) {
  return crypto.createHash("sha256").update(stableSerialize(body ?? null)).digest("hex");
}

export function hashRequestBytes(body = Buffer.alloc(0)) {
  return crypto.createHash("sha256").update(body).digest("hex");
}

function serviceSigningInput({ service, timestamp, requestId, bodyHash, method = "", path = "", audience = "" }) {
  return `${service}.${timestamp}.${requestId}.${method}.${path}.${audience}.${bodyHash}`;
}

export function signServiceRequest({ service, timestamp, requestId, bodyHash, method, path, audience, secret } = {}) {
  if (!service || !timestamp || !requestId || !bodyHash || !secret) throw new Error("Service signing fields are required");
  return crypto.createHmac("sha256", secret).update(serviceSigningInput({ service, timestamp, requestId, bodyHash, method, path, audience })).digest("hex");
}

export function verifyServiceSignature({ service, timestamp, requestId, bodyHash, method, path, audience, signature, secret, maxClockSkewMs = 300_000, now = Date.now() } = {}) {
  const timestampMs = Number(timestamp);
  if (!Number.isSafeInteger(timestampMs) || Math.abs(now - timestampMs) > maxClockSkewMs) return false;
  if (!signature || !secret) return false;
  const expected = signServiceRequest({ service, timestamp, requestId, bodyHash, method, path, audience, secret });
  const actualBytes = Buffer.from(signature, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

export function createServiceRequestHeaders({ service = "api-gateway", requestId, body, method, path, audience, secret, now = Date.now() } = {}) {
  const timestamp = String(now);
  const bodyHash = Buffer.isBuffer(body) ? hashRequestBytes(body) : hashRequestBody(body);
  return {
    "x-ayzen-service": service,
    "x-ayzen-timestamp": timestamp,
    "x-ayzen-request-id": requestId,
    "x-ayzen-body-sha256": bodyHash,
    ...(method ? { "x-ayzen-method": method } : {}),
    ...(path ? { "x-ayzen-path": path } : {}),
    ...(audience ? { "x-ayzen-audience": audience } : {}),
    "x-ayzen-signature": signServiceRequest({ service, timestamp, requestId, bodyHash, method, path, audience, secret }),
  };
}

export function verifyServiceRequestHeaders(headers = {}, { secret, now = Date.now() } = {}) {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return verifyServiceSignature({
    service: normalized["x-ayzen-service"],
    timestamp: normalized["x-ayzen-timestamp"],
    requestId: normalized["x-ayzen-request-id"],
    bodyHash: normalized["x-ayzen-body-sha256"],
    method: normalized["x-ayzen-method"],
    path: normalized["x-ayzen-path"],
    audience: normalized["x-ayzen-audience"],
    signature: normalized["x-ayzen-signature"],
    secret,
    now,
  });
}

function stepUpSigningInput({ subject, purpose, organizationId = "", workspaceId = "", issuedAt, expiresAt, nonce }) {
  return `${subject}.${purpose}.${organizationId}.${workspaceId}.${issuedAt}.${expiresAt}.${nonce}`;
}

/**
 * Create a short-lived, purpose-bound elevation token. The token carries no
 * secret material; it only proves that the issuer approved one action for one
 * actor and tenant. Consumers must pass a single-use set to verification.
 */
export function createStepUpToken({
  subject,
  purpose,
  organizationId,
  workspaceId,
  secret = process.env.AYZEN_STEP_UP_SECRET,
  now = Date.now(),
  ttlMs = 300_000,
  nonce = crypto.randomUUID(),
} = {}) {
  if (!subject || !purpose || !secret) throw new Error("Step-up subject, purpose, and secret are required");
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 900_000) throw new Error("Step-up TTL is invalid");
  const issuedAt = now;
  const expiresAt = now + ttlMs;
  const input = stepUpSigningInput({ subject, purpose, organizationId, workspaceId, issuedAt, expiresAt, nonce });
  const signature = crypto.createHmac("sha256", secret).update(input).digest("base64url");
  return Buffer.from(JSON.stringify({ subject, purpose, organizationId, workspaceId, issuedAt, expiresAt, nonce, signature })).toString("base64url");
}

export function verifyStepUpToken(token, {
  subject,
  purpose,
  organizationId,
  workspaceId,
  secret = process.env.AYZEN_STEP_UP_SECRET,
  now = Date.now(),
  consumed = new Set(),
} = {}) {
  const deny = (reason) => ({ valid: false, reason });
  if (!secret || typeof token !== "string") return deny("STEP_UP_NOT_CONFIGURED");
  let claims;
  try { claims = JSON.parse(Buffer.from(token, "base64url").toString("utf8")); } catch { return deny("STEP_UP_MALFORMED"); }
  if (claims.subject !== subject || claims.purpose !== purpose) return deny("STEP_UP_BINDING_MISMATCH");
  if ((claims.organizationId ?? undefined) !== (organizationId ?? undefined) || (claims.workspaceId ?? undefined) !== (workspaceId ?? undefined)) return deny("STEP_UP_TENANT_MISMATCH");
  if (!Number.isSafeInteger(claims.issuedAt) || !Number.isSafeInteger(claims.expiresAt) || claims.expiresAt <= now || claims.issuedAt > now) return deny("STEP_UP_EXPIRED");
  if (!claims.nonce || consumed.has(claims.nonce)) return deny("STEP_UP_REPLAYED");
  const expected = crypto.createHmac("sha256", secret).update(stepUpSigningInput(claims)).digest("base64url");
  const actual = Buffer.from(String(claims.signature ?? ""));
  const expectedBytes = Buffer.from(expected);
  if (actual.length !== expectedBytes.length || !crypto.timingSafeEqual(actual, expectedBytes)) return deny("STEP_UP_INVALID");
  consumed.add(claims.nonce);
  return { valid: true, claims };
}

export function createTelegramIdentityLink({
  userId,
  telegramUserId,
  username,
  botKey,
  verified = false,
  verifiedAt,
} = {}) {
  if (typeof userId !== "string" || !userId.trim()) throw new Error("Stable user ID is required");
  if (!Number.isSafeInteger(telegramUserId) || telegramUserId < 1) throw new Error("Telegram user ID is required");
  if (typeof botKey !== "string" || !/^[a-z0-9-]{1,64}$/.test(botKey)) throw new Error("Telegram bot key is invalid");
  return Object.freeze({
    userId,
    telegramUserId,
    ...(typeof username === "string" && username ? { username } : {}),
    botKey,
    status: verified ? "verified" : "pending",
    ...(verifiedAt ? { verifiedAt } : {}),
  });
}

export function assertVerifiedTelegramLink(link) {
  if (!link || link.status !== "verified" || !Number.isSafeInteger(link.telegramUserId)) {
    throw new Error("Verified Telegram identity link is required");
  }
  return link;
}