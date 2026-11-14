import "./lib/express-async-errors"; // FIN F12: idempotent; keeps tests that import app directly safe
import * as Sentry from "@sentry/node"; // sentry express error handler (init happens in index.ts)
import express, { type Express, type RequestHandler } from "express";
import pinoHttp from "pino-http";
import cookieParser from "cookie-parser";
import { moduleRequestContext } from "./lib/module-request-context";
import path from "path";
import fs from "fs";
import { robotsTxt, sitemapXml } from "@ayzen/module-registry/landing";
import { designAssets, designIds, designedLandingHtml } from "@ayzen/module-registry/landing-designs";
import { fileURLToPath } from "url";
import router from "./routes";
import wellKnownJwksRouter from "./routes/well-known-jwks";
import wellKnownOpenidConfigurationRouter from "./routes/well-known-openid-configuration";
import oidcAuthorizeRouter from "./routes/oidc-authorize";
import oidcTokenRouter from "./routes/oidc-token";
import oidcUserinfoRouter from "./routes/oidc-userinfo";
import oidcResourceRouter from "./routes/oidc-resource";
import oidcRolloutFlagRouter from "./routes/oidc-rollout-flag";
import oidcClientErrorsRouter from "./routes/oidc-client-errors";
import oidcLogoutRouter from "./routes/oidc-logout";
import oidcBackchannelLogoutRouter from "./routes/oidc-backchannel-logout";
import oidcConsentRouter from "./routes/oidc-consent";
// Season 4, Phase 7d (route half) + Season 5, Phase 10d — see
// routes/oidc-connected-apps.ts's own header for the full request/response
// contract. Same bare-origin, non-`/api`, no-`apiKeyScopeGate`,
// `requireAuth`-gated mounting as oidcConsentRouter just above.
import oidcConnectedAppsRouter from "./routes/oidc-connected-apps";
// OIDC Roadmap — Season 4, Phase 8a/8e. Same bare-origin, non-`/api`,
// no-`apiKeyScopeGate` mounting as every other `/oidc/*` router above —
// see routes/oidc-register.ts's own header for the full request/response
// flow and why `POST /oidc/register` in particular must stay
// unauthenticated.
import oidcRegisterRouter from "./routes/oidc-register";

// Season 5, Phase 10a — see routes/oidc-introspect.ts's own header for
// the full request/response contract and why it's mounted bare-origin,
// same as every other `/oidc/*` router in this file.
import oidcIntrospectRouter from "./routes/oidc-introspect";
// Season 5, Phase 10b — see routes/oidc-revoke.ts's own header for the
// full request/response contract; same bare-origin/authLimiter mounting
// tier as oidcIntrospectRouter just above.
import oidcRevokeRouter from "./routes/oidc-revoke";
import { logger } from "./lib/logger";
import { issuerProblem, resolveIssuer } from "./lib/oidc-discovery";
import { logBus } from "./lib/log-bus";
import { globalErrorHandler, notFoundHandler } from "./middlewares/error-handler";
import {
  securityHeaders,
  corsMiddleware,
  globalLimiter,
  dedupeQueryParams,
  sanitizeBody,
  JSON_BODY_LIMIT,
} from "./middlewares/security";
import { apiKeyScopeGate } from "./middlewares/api-key-scope";
import { roleHostApiGate, roleHostPageGate } from "./middlewares/role-host";
import { moduleHostApiGuard, moduleHostHeaders, moduleHostPageGuard } from "./lib/module-host-guard";
import mcpRouter from "./routes/mcp";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { runWithTraceContext, traceContextFromHeaders } from "./lib/trace-context";
import { gatewayContextMiddleware } from "./lib/gateway-context";
import { sioraRequestTelemetry } from "./lib/siora/request-middleware";
import { SHARED_APP_DEFINITIONS, getSharedAppHosts } from "./lib/shared-apps";
import { isApiHost } from "./lib/api-hosts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app: Express = express();


// Behind Render/Replit's reverse proxy — needed so req.ip and the rate
// limiter see the real client IP (X-Forwarded-For) instead of the proxy's.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

// J3 — establish one trace context for every request. AsyncLocalStorage
// carries it through route/service/event/scheduler calls without requiring
// every domain method to thread an optional request object.
app.use((req, res, next) => {
  const context = traceContextFromHeaders(req.headers);
  res.setHeader("x-trace-id", context.traceId);
  if (context.correlationId) res.setHeader("x-correlation-id", context.correlationId);
  runWithTraceContext(context, next);
});
// API Gateway context is transport metadata only. Authorization middleware
// resolves the authenticated user/workspace later and never trusts headers.
app.use(gatewayContextMiddleware);

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const durationMs = Date.now() - start;
    const code = res.statusCode;
    const level = code >= 500 ? "ERROR" : code >= 400 ? "WARN" : "INFO";
    const route = req.url?.split("?")[0] ?? "/";
    logBus.push({
      time: Date.now(),
      level,
      msg: `${req.method} ${route} → ${code}`,
      method: req.method,
      url: route,
      statusCode: code,
      ms: durationMs,
    });
    // Write to request_metrics table (fire-and-forget, only for /api/* routes).
    // Uses drizzle's parameterized `sql` tag (bind params) instead of sql.raw
    // + manual string interpolation — the previous version built the query
    // with string concatenation, which is the exact pattern SQL injection
    // comes from even when individual fields look "safe enough to escape".
    if (route.startsWith("/api/")) {
      db.execute(
        sql`INSERT INTO request_metrics (route, method, status_code, duration_ms)
            VALUES (${route}, ${req.method}, ${code}, ${durationMs})`,
      ).catch(() => { /* ignore until table exists after migration */ });
    }
  });
  next();
});

// ── Security layer ───────────────────────────────────────────────────────────
// See middlewares/security.ts for the full rationale behind each piece.
app.use(securityHeaders);
// W2-P1: per-module CSP frame-ancestors + Referrer-Policy on module hosts (only when MODULE_HOST_GUARD_MODE is owned|strict).
app.use(moduleHostHeaders);
app.use(corsMiddleware);
// Reads the AYZEN Account session cookie (lib/session-cookie.ts) so
// getTokenFromReq() can fall back to it when a request has no
// Authorization header — this is what lets *.ayzen.tech subdomains share
// one login without each one re-sending a bearer token. Unsigned (JWT
// verification happens later, same as the header path) — just parsing.
app.use(cookieParser());
// W1-P2: records which module this request is acting for (first-party Origin, else Host) so getUserFromToken() can
// refuse a module session anywhere but its own module. Must run before every router that authenticates.
app.use(moduleRequestContext);
// Resend's inbound webhook needs the RAW body to verify its Svix signature
// (see routes/resend-webhook.ts) — carve it out before the global json/urlencoded
// parsers touch anything under /api, or the raw bytes are gone by the time we see them.
const RESEND_WEBHOOK_PATH = "/api/webhooks/resend/inbound";
app.use(RESEND_WEBHOOK_PATH, express.raw({ type: "*/*", limit: "10mb" }));
// W1-P5: Clerk (Svix) webhooks, one path per module, also signature-verified over the raw body (routes/clerk-webhook.ts).
const CLERK_WEBHOOK_PREFIX = "/api/webhooks/clerk";
app.use(CLERK_WEBHOOK_PREFIX, express.raw({ type: "*/*", limit: "1mb" }));
const hasRawBody = (url: string) => url === RESEND_WEBHOOK_PATH || url.startsWith(`${CLERK_WEBHOOK_PREFIX}/`);
app.use((req, res, next) => (hasRawBody(req.originalUrl) ? next() : express.json({ limit: JSON_BODY_LIMIT })(req, res, next)));
app.use((req, res, next) => (hasRawBody(req.originalUrl) ? next() : express.urlencoded({ extended: true, limit: JSON_BODY_LIMIT })(req, res, next)));
// Accepts raw CSV body (e.g. vault bulk import/export) alongside JSON.
app.use(express.text({ type: ["text/csv", "text/plain"], limit: "5mb" }));
app.use(dedupeQueryParams);
app.use(sanitizeBody);
// SIORA Seasons 1–5: observe normalized request behavior without replacing
// auth, sessions, rate limiting, or policy decisions.
app.use(sioraRequestTelemetry);

// OIDC discovery well-known endpoints — deliberately mounted at the bare
// origin (not under /api, and not behind apiKeyScopeGate): OIDC/RFC 8414
// clients resolve these relative to the issuer's origin, and a JWKS
// endpoint that verifies tokens (plus the discovery document that points
// at it) is by definition public (see routes/well-known-jwks.ts and
// routes/well-known-openid-configuration.ts for the rest of the
// rationale).
app.use(wellKnownJwksRouter);
app.use(wellKnownOpenidConfigurationRouter);
// W1-P3: the issuer is baked into every ID token and each relying party's config, so a malformed one
// (no scheme, http in prod, query string) breaks all logins at once — fail loud in the boot log.
{
  const problem = issuerProblem(resolveIssuer());
  if (problem) logger.error({ issuer: resolveIssuer(), problem }, "oidc.issuer.invalid");
}

// `/oidc/authorize` — Season 2, Phase 3a (Authorization Request
// Validation only; see routes/oidc-authorize.ts for the full scope
// boundary). Mounted at the bare origin for the same reason as the two
// `well-known` routers above — an OIDC client builds this URL directly
// against the issuer's origin, not through `/api` — and NOT behind
// `apiKeyScopeGate`, which exists to scope THIS deployment's internal API
// key usage, not to gate a public OIDC endpoint a client is never expected
// to hold that key for. It has its own rate limiting (`authLimiter`,
// applied in the route file) instead of `globalLimiter`.
app.use(oidcAuthorizeRouter);

// `/oidc/token` — Season 2, Phase 3c (Token Endpoint) + Phase 3d (PKCE
// Enforcement). Same bare-origin, non-`/api`, no-`apiKeyScopeGate` mounting
// as `/oidc/authorize` above and for the identical reason: an OIDC client's
// backend calls this URL directly against the issuer's origin. See
// routes/oidc-token.ts for the full scope boundary and rate-limiting
// rationale (`authLimiter`, applied in the route file).
app.use(oidcTokenRouter);

// `/oidc/userinfo` — Season 2, Phase 4c (UserInfo). Same bare-origin,
// non-`/api`, no-`apiKeyScopeGate` mounting as `/oidc/authorize` and
// `/oidc/token` above, for the identical reason: an OIDC client's backend
// calls this URL directly against the issuer's origin. See
// routes/oidc-userinfo.ts for the full scope boundary, RFC 6750 error
// shape, and rate-limiting rationale (`globalLimiter`, not `authLimiter`
// — applied in the route file).
app.use(oidcUserinfoRouter);

// `/oidc/resource/*` — Season 2, Phase 4e (Middleware Rollout). Same
// bare-origin, non-`/api`, no-`apiKeyScopeGate` mounting as the three
// OIDC routers above, for the identical reason. See
// routes/oidc-resource.ts for why these two routes (not any existing
// `/api/*` route) are what 4e-a selected, and for the scope-enforcement
// wiring itself (4e-b).
app.use(oidcResourceRouter);

// `/oidc/rollout-flags/:appId` — Season 3, Phase 5c-a. Same bare-origin,
// non-`/api`, no-`apiKeyScopeGate`, `globalLimiter` mounting as the OIDC
// routers above, and public rather than `requireAuth`-gated for the
// identical "before any session exists" reason — see
// routes/oidc-rollout-flag.ts's own header.
app.use(oidcRolloutFlagRouter);

// `/oidc/client-errors` — Season 3, Phase 5e-b. Bare-origin,
// `globalLimiter`, unauthenticated one-way beacon for `/oidc/callback`'s
// browser-only failure states — see routes/oidc-client-errors.ts's own
// header for the full trust model.
app.use(oidcClientErrorsRouter);

// `/oidc/logout` — Season 3, Phase 6a (RP-Initiated Logout Request) +
// Phase 6b (Session Termination) — this provider's `end_session_endpoint`.
// Same bare-origin, non-`/api`, no-`apiKeyScopeGate` mounting as the other
// `/oidc/*` routers above, for the identical reason — see
// routes/oidc-logout.ts's own header for the full request/response flow
// and why it reuses POST /auth/logout's exact session-revocation
// mechanism rather than a new one.
app.use(oidcLogoutRouter);

// `/oidc/backchannel-logout` — Season 3, Phase 6e-b (Sylo Integration).
// Same bare-origin, no-`/api`, no-`apiKeyScopeGate` mounting as every
// other `/oidc/*` router above — see routes/oidc-backchannel-logout.ts's
// own header for the full request/response contract.
app.use(oidcBackchannelLogoutRouter);

// `/oidc/consent/*` — Season 4, Phase 7b (Consent UI, backend half). Same
// bare-origin, non-`/api`, no-`apiKeyScopeGate` mounting as every other
// `/oidc/*` router above — see routes/oidc-consent.ts's own header for the
// full request/response contract. Unlike the routers above, every route
// in this one is `requireAuth`-gated (applied per-route in the file
// itself) — there is no anonymous caller for a screen shown "after
// login."
app.use(oidcConsentRouter);

// `/oidc/connected-apps`, `/oidc/connected-apps/:clientId/revoke` — Season
// 4, Phase 7d (route half, built out) + Season 5, Phase 10d (cascade
// wiring). Same bare-origin, non-`/api`, no-`apiKeyScopeGate` mounting as
// oidcConsentRouter above, and same `requireAuth` (not `apiKeyScopeGate`)
// gate applied per-route in the file itself — see
// routes/oidc-connected-apps.ts's own header for the full contract.
app.use(oidcConnectedAppsRouter);

// `/oidc/register`, `/oidc/register/:client_id` — Season 4, Phase 8a
// (register) + Phase 8e (self-management GET/PUT). Same bare-origin,
// non-`/api`, no-`apiKeyScopeGate` mounting as every other `/oidc/*`
// router above — see routes/oidc-register.ts's own header for the full
// scope boundary (`POST` unauthenticated by design; `GET`/`PUT
// /oidc/register/:client_id` bearer-authenticated via
// `registration_access_token`, not an AYZEN session).
app.use(oidcRegisterRouter);

// `/oidc/introspect` — Season 5, Phase 10a (Introspection Endpoint, RFC
// 7662-scoped-down). Same bare-origin, non-`/api`, no-`apiKeyScopeGate`
// mounting as every other `/oidc/*` router above, and same `authLimiter`
// tier as `/oidc/token` — see routes/oidc-introspect.ts's own header for
// the full request/response contract.
app.use(oidcIntrospectRouter);

// `/oidc/revoke` — Season 5, Phase 10b (Revocation Endpoint, RFC
// 7009-scoped-down). Same bare-origin, non-`/api`, no-`apiKeyScopeGate`,
// `authLimiter` mounting as `oidcIntrospectRouter` just above — see
// routes/oidc-revoke.ts's own header for the full request/response
// contract. Phase 10c's cascade functions and Phase 10d's actual 7d/9c/9d
// call sites + backchannel-logout hook are wired in via
// `oidcConnectedAppsRouter` (7d) and `routes/admin-oidc-clients.ts` (9c/9d)
// — see each file's own header. Discovery metadata (`revocation_endpoint`
// on `/.well-known/openid-configuration`), Phase 10e, is still not wired.
app.use(oidcRevokeRouter);

// MCP server at the bare origin of the API/MCP hosts (https://api.ayzen.tech/mcp,
// https://mcp.ayzen.tech/mcp). The same router also stays mounted at /api/mcp
// (routes/index.ts). It does its own API-key auth, scope check and rate limit,
// so it needs neither apiKeyScopeGate nor globalLimiter here. Phase 8.
app.use((req, res, next) => (isApiHost(req.hostname) ? (mcpRouter as unknown as RequestHandler)(req, res, next) : next()));

// W2-P1: another module's API path is a plain 404 for a request acting for this module (lib/module-host-guard.ts; off by default).
app.use("/api", globalLimiter, moduleHostApiGuard, roleHostApiGate, apiKeyScopeGate, router);

app.use("/api/{*splat}", notFoundHandler);
app.use(globalErrorHandler as any);

// ── API host (api.ayzen.tech) ────────────────────────────────────────────────
// Phase 2. Real routes have had their chance. Do not serve the SPA or redirect
// module paths on the API host.
app.use((req, res, next) => {
  if (!isApiHost(req.hostname)) return next();
  if (req.path === "/" || req.path === "") {
    res.json({ service: "ayzen-api", status: "ok", base: "/api" });
    return;
  }
  res.status(404).json({ error: "Route not found", code: "NOT_FOUND" });
});

// ── Role hosts (admin / mod / team leader) ──────────────────────────────────
// Phase 7. No-op unless ROLE_HOSTS_ENABLED=1. See lib/role-hosts.ts for the
// decision table; the API half of the same rule is mounted on /api above.
// W2-P1: another module's PAGE path on a module host is a 404 too (same mode switch).
app.use(moduleHostPageGuard);
app.use(roleHostPageGate);

// ── Serve built frontend in production ───────────────────────────────────────
// AYZEN Workspace subdomain scoping (master plan §7 Phase 2 — Sylo split;
// Phase 3 — Ryft/Wisp/Verve added the same way). This is still ONE deployed
// app serving every *.ayzen.tech host — the subdomain-scoped behavior
// (restricted nav, route redirects) is handled client-side once the SPA
// boots (see lib/subdomain-app.ts). The one thing worth doing server-side is
// redirecting a bare "/" hit on a scoped hostname straight to that app's
// home route BEFORE the full Workspace shell's index.html even loads, so a
// visitor never sees a flash of the wrong app.
//
// One entry per split app, each independently configurable via its own
// `<ID>_HOSTS` env var (comma-separated) so hostnames can be rolled out one
// at a time — defaults match the matching `VITE_<ID>_HOSTS` fallback in
// subdomain-app.ts (`<id>.ayzen.tech`). Zynth is intentionally absent here
// too — see subdomain-app.ts's header for why (no user-facing route yet).
interface SplitAppHostConfig { id: string; hosts: string[]; homePath: string }

const SPLIT_APP_HOST_CONFIG: SplitAppHostConfig[] = SHARED_APP_DEFINITIONS.map((definition) => ({
  id: definition.id,
  hosts: getSharedAppHosts(definition),
  homePath: definition.homePath,
}));

// Flat hostname → homePath lookup built once at startup, so the per-request
// redirect check below is a single Map.get() rather than looping every app
// on every request.
const SPLIT_APP_ID_BY_HOST = new Map<string, string>(
  SPLIT_APP_HOST_CONFIG.flatMap((c) => c.hosts.map((h) => [h, c.id] as const)),
);
// The server is bundled, so tell the registry where the landing designs live (repo checkout, next to the API build).
process.env.MODULE_LANDINGS_DIR ??= path.resolve(__dirname, "../../../packages/module-registry/landings");
function buildLandingByHost(): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of SPLIT_APP_HOST_CONFIG) {
    for (const host of c.hosts) {
      const html = designedLandingHtml(c.id, { origin: `https://${host}` });
      if (html) out.set(host, html);
    }
  }
  return out;
}
// Files a designed landing may load (fonts, css, js, sibling pages), allow-listed so the raw design (with its demo sign-in
// markup) is never served from here.
const LANDING_ASSET_FILES = new Map<string, string>(
  designIds().flatMap((id) => designAssets(id).map((a) => [`${id}/${a.rel}`, a.abs] as const)),
);
const SPLIT_APP_HOME_BY_HOST = new Map<string, string>(
  SPLIT_APP_HOST_CONFIG.flatMap((c) => c.hosts.map((h) => [h, c.homePath] as const)),
);

// Module Shell Split - Season 6: optional server-side central -> module
// 308 redirect for non-API requests on the central host when
// SPLIT_REDIRECTS=1. Never for /api. Per-module rollout via
// SPLIT_REDIRECT_MODULES (comma list). Public token pages and the OIDC
// callback are exempt. getSharedAppForHost returns null on the central
// host, so module hosts never loop back to central (module hosts fall
// through to static serving below). /nft-marketplace lands on verve.
const SPLIT_REDIRECTS = process.env.SPLIT_REDIRECTS === "1";
const SPLIT_REDIRECT_MODULES = (process.env.SPLIT_REDIRECT_MODULES ?? "")
  .split(",").map((m) => m.trim().toLowerCase()).filter(Boolean);
const PUBLIC_TOKEN_PREFIXES = ["/login", "/register", "/forgot-password", "/status",
  "/emergency-access", "/finance/receipt", "/finance/invoice", "/finance/payment-agreement",
  "/receipt", "/oidc/callback"];
if (SPLIT_REDIRECTS) {
  const byId = new Map(SHARED_APP_DEFINITIONS.map((d) => [d.id, d] as const));
  app.get("/{*splat}", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    const pathOnly = req.path.split("?")[0];
    if (PUBLIC_TOKEN_PREFIXES.some((p) => pathOnly === p || pathOnly.startsWith(p + "/"))) return next();
    const isLegacyNft = pathOnly === "/nft-marketplace";
    const appDef = isLegacyNft ? byId.get("verve") : SHARED_APP_DEFINITIONS.find((d) =>
      d.routePrefixes.some((p) => pathOnly === p || pathOnly.startsWith(p + "/")));
    if (!appDef) return next();
    if (!isLegacyNft && SPLIT_REDIRECT_MODULES.length > 0 && !SPLIT_REDIRECT_MODULES.includes(appDef.id)) return next();
    const host = getSharedAppHosts(appDef)[0];
    return res.redirect(308, `https://${host}${req.originalUrl}`);
  });
}

if (process.env.NODE_ENV === "production") {
  const distPath = path.resolve(__dirname, "../../ayzen/dist/public");
  // W2-P4: with MODULE_LANDING_ENABLED=1 a module host serves its own landing (SEO tags + prerendered body) at "/" instead of a
  // 302. The inline guard in the HTML clears it for signed-in visitors, and the SPA then redirects them to the module home.
  const landingByHost = process.env.MODULE_LANDING_ENABLED === "1" ? buildLandingByHost() : new Map<string, string>();
  app.get("/landing-assets/{*file}", (req, res, next) => {
    if (!landingByHost.size) return next();
    const key = [].concat((req.params as any).file ?? []).join("/");
    const abs = LANDING_ASSET_FILES.get(key);
    if (!abs) return next();
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.sendFile(abs);
  });
  app.get("/robots.txt", (req, res, next) => {
    const id = SPLIT_APP_ID_BY_HOST.get(req.hostname);
    if (!id || !landingByHost.size) return next();
    res.type("text/plain").send(robotsTxt(id, { origin: `https://${req.hostname}` }));
  });
  app.get("/sitemap.xml", (req, res, next) => {
    const id = SPLIT_APP_ID_BY_HOST.get(req.hostname);
    if (!id || !landingByHost.size) return next();
    res.type("application/xml").send(sitemapXml(id, { origin: `https://${req.hostname}` }));
  });
  // "/" must be answered BEFORE express.static, which would otherwise serve the SPA's index.html for it.
  app.get("/", (req, res, next) => {
    const landing = landingByHost.get(req.hostname);
    if (!landing) return next();
    res.setHeader("Cache-Control", "public, max-age=300");
    res.type("html").send(landing);
  });
  app.use(express.static(distPath));
  app.get("/{*splat}", (req, res) => {
    const homePath = SPLIT_APP_HOME_BY_HOST.get(req.hostname);
    if ((req.path === "/" || req.path === "") && homePath) {
      res.redirect(302, homePath);
      return;
    }
    res.sendFile(path.join(distPath, "index.html"));
  });
}

// Sentry express error handler must be added AFTER all routes/controllers
app.use(Sentry.expressErrorHandler());

export default app;
