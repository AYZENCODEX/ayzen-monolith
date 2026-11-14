/**
 * lib/module-request-context.ts — W1-P2: "which module is this request acting for?"
 *
 * getUserFromToken() (lib/auth-utils.ts) is the single choke point for every auth path but takes a bare token,
 * not a request. This tiny AsyncLocalStorage carries the one fact it needs: the module the request is acting for.
 *
 *   caller host = the first-party Origin when the browser sent one (the SPA on sylo.ayzen.tech calling
 *                 api.ayzen.tech), otherwise the Host header (same-origin calls made on the module host itself).
 *                 An Origin that is present but NOT first-party yields "no module" — it never falls back to Host.
 *   context     = the module that caller host belongs to, or null (central app, API host without a module
 *                 Origin, unknown host, non-HTTP code such as workers and scripts).
 *
 * A module session is accepted only when its `mod` claim equals this context (lib/module-session-policy.ts).
 * With no store at all (workers, scripts, tests) the context is null, so a module token is NEVER valid there.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";
import type { ModuleId } from "@ayzen/module-registry";
import { isFirstPartyOrigin } from "./api-hosts";
import { resolveRequestModule } from "./module-session-policy";

interface Store { module: ModuleId | null }
const storage = new AsyncLocalStorage<Store>();

/** The module the current request is acting for, or null. */
export function currentModuleContext(): ModuleId | null {
  return storage.getStore()?.module ?? null;
}

/** Pure: the module a (host, origin) pair is acting for. Exported for tests. */
export function resolveCallerModule(input: { hostname: string | undefined; origin: string | undefined }): ModuleId | null {
  const { hostname, origin } = input;
  if (typeof origin === "string" && origin !== "") {
    if (!isFirstPartyOrigin(origin)) return null;
    try { return resolveRequestModule(new URL(origin).hostname); } catch { return null; }
  }
  return resolveRequestModule(hostname);
}

export function runWithModuleContext<T>(module: ModuleId | null, fn: () => T): T {
  return storage.run({ module }, fn);
}

/** Express middleware: establishes the context for everything downstream of it (mount it early). */
export function moduleRequestContext(req: Request, _res: Response, next: NextFunction): void {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  const module = resolveCallerModule({ hostname: req.hostname, origin });
  storage.run({ module }, () => next());
}
