/**
 * lib/module-host-guard.ts — W2-P1 (req 4): the server stops trusting the browser to keep modules apart.
 *
 * shared-apps.ts only maps host -> module; it never blocked anything, so a page on sylo.ayzen.tech could call another
 * module's API. This file adds the enforcement, controlled by ONE switch:
 *
 *   MODULE_HOST_GUARD_MODE   off (default) | report | owned | strict
 *     off     nothing changes.
 *     report  log `module_host_guard.would_deny` for what owned/strict would refuse; refuse nothing. Use it first.
 *     owned   a request acting for module M gets a plain 404 on any path owned by ANOTHER module (registry routePrefixes).
 *             Paths owned by nobody (shared platform APIs) stay reachable. Recommended steady state.
 *     strict  as owned, and unowned paths are 404 too unless allow-listed (/auth /oidc /.well-known /health /connector)
 *             or listed in MODULE_HOST_GUARD_SHARED_PREFIXES (comma list). NOT recommended until the registry's route
 *             ownership is complete: today ~half of the API surface (e.g. /users, /notifications, /vault-shares) is unowned.
 *   owned and strict additionally turn on: a per-module CORS allow-list (a first-party origin must be a REGISTERED host,
 *   not just any *.ayzen.tech) and per-module response headers (CSP frame-ancestors, Referrer-Policy) on module hosts.
 *
 * "Acting for module M" is lib/module-request-context.ts: the first-party Origin when the browser sent one, else the Host.
 * Requests with no module context (central app, API host without a module Origin, workers, curl) are not touched: this is
 * defence in depth for browser traffic, and authentication/authorization stay owned by the existing middleware.
 * A denied request gets the SAME 404 body as an unknown endpoint, so the response does not reveal that the path exists.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ModuleId } from "@ayzen/module-registry";
import { logger } from "./logger";
import { currentModuleContext } from "./module-request-context";
import { resolveRequestModule } from "./module-session-policy";
import { isApiHost } from "./api-hosts";
import { evaluateGuard, isModuleHostGuardEnforcing, moduleFrameAncestors, moduleHostGuardMode } from "./module-host-guard-core";
import { notFoundHandler } from "../middlewares/error-handler";

export * from "./module-host-guard-core";

function apply(kind: "api" | "page", module: ModuleId | null, req: Request, res: Response, next: NextFunction): void {
  const mode = moduleHostGuardMode();
  const r = evaluateGuard(mode, module, req.path);
  if (r.wouldDeny) logger.warn({ module, path: req.path, method: req.method, kind, mode, reason: r.reason }, mode === "report" ? "module_host_guard.would_deny" : "module_host_guard.denied");
  if (r.refuse) { notFoundHandler(req, res); return; }
  next();
}

/** Mounted on /api before the router (req.path is relative to /api, exactly the prefixes the registry lists). */
export const moduleHostApiGuard: RequestHandler = (req, res, next) => apply("api", currentModuleContext(), req, res, next);

const ASSET_PATH = /\.[a-z0-9]{1,8}$/i;
/** Page requests on a module's own host: another module's pages are 404 (the SPA shell is not served for them). */
export const moduleHostPageGuard: RequestHandler = (req, res, next) => {
  if ((req.method !== "GET" && req.method !== "HEAD") || req.path.startsWith("/api") || isApiHost(req.hostname)) { next(); return; }
  // Assets (js/css/images) are shared files, not module routes. Judge by Host only: a page load has no Origin.
  if (ASSET_PATH.test(req.path)) { next(); return; }
  apply("page", resolveRequestModule(req.hostname), req, res, next);
};

export const moduleHostHeaders: RequestHandler = (req, res, next) => {
  if (isModuleHostGuardEnforcing() && resolveRequestModule(req.hostname)) {
    res.setHeader("Content-Security-Policy", `frame-ancestors ${moduleFrameAncestors()}`);
    res.setHeader("Referrer-Policy", "no-referrer");
  }
  next();
};
