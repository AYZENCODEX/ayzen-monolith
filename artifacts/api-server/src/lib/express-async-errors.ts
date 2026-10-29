/**
 * lib/express-async-errors.ts  (FIN F12)
 * ─────────────────────────────────────────────────────────────────────────────
 * Express 4 does not look at the promise an `async` handler returns, so a throw
 * (or rejected await) inside one is an unhandled rejection: the request hangs
 * and Node may exit. This module makes Express 4 forward that rejection to
 * `next(err)`, so it reaches `globalErrorHandler` (JSON 500, logged, recorded).
 *
 * It is the same technique as the `express-async-errors` package, kept in-repo
 * because the package cannot be added to the lockfile from here. It patches the
 * `Layer` class that Express itself uses, so it covers every router and
 * middleware in the app without editing any route file.
 *
 * Contract:
 *  - MUST be the first import of every entrypoint (a Layer wraps its handler
 *    when it is constructed, i.e. when `router.get(...)` runs at import time).
 *  - Idempotent: importing twice, or patching twice, wraps once.
 *  - Only affects handlers that return a thenable. Sync handlers, and handlers
 *    that already call `next(err)` or respond themselves, behave as before.
 *  - If a handler rejects after it already sent a response, the error is
 *    passed to `next(err)`; Express' default path then closes the connection
 *    rather than writing twice (`globalErrorHandler` does not write when
 *    `res.headersSent`, see middlewares/error-handler.ts).
 */
import Layer from "express/lib/router/layer.js";

type AnyFn = (...args: unknown[]) => unknown;
const PATCHED = Symbol.for("ayzen.expressAsyncErrors.patched");
const noop = () => {};

export function wrapAsyncHandler(fn: AnyFn): AnyFn {
  const wrapped = function (this: unknown, ...args: unknown[]) {
    const ret = fn.apply(this, args);
    // (err, req, res, next) handlers have 4 params; (req, res, next) have 3.
    const next = (fn.length === 4 ? args[3] : args[args.length - 1]) as ((e?: unknown) => void) | undefined;
    if (ret && typeof (ret as Promise<unknown>).catch === "function") {
      (ret as Promise<unknown>).catch((err: unknown) => (typeof next === "function" ? next : noop)(err));
    }
    return ret;
  };
  Object.defineProperty(wrapped, "length", { value: fn.length });
  for (const key of Object.getOwnPropertyNames(fn)) {
    if (key === "length" || key === "name" || key === "prototype") continue;
    const desc = Object.getOwnPropertyDescriptor(fn, key);
    if (desc) Object.defineProperty(wrapped, key, desc);
  }
  return wrapped as AnyFn;
}

export function installExpressAsyncErrors(): boolean {
  const proto = (Layer as unknown as { prototype: Record<PropertyKey, unknown> }).prototype;
  if (proto[PATCHED]) return false;
  Object.defineProperty(proto, "handle", {
    enumerable: true,
    configurable: true,
    get(this: { __handle?: AnyFn }) {
      return this.__handle;
    },
    set(this: { __handle?: AnyFn }, fn: AnyFn) {
      this.__handle = typeof fn === "function" ? wrapAsyncHandler(fn) : fn;
    },
  });
  Object.defineProperty(proto, PATCHED, { value: true });
  return true;
}

installExpressAsyncErrors();
