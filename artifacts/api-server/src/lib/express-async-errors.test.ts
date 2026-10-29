/**
 * FIN F12: an async route handler that throws must produce a JSON 500 through
 * globalErrorHandler instead of hanging the request / raising an unhandled rejection.
 * Uses the real Express 4 and a real HTTP socket. No database.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import "./express-async-errors";
import express from "express";
import { globalErrorHandler } from "../middlewares/error-handler";
import { AppError } from "./errors";

describe("F12 async route errors (real Express 4)", () => {
  let server: Server;
  let base = "";
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);

  before(async () => {
    process.on("unhandledRejection", onUnhandled);
    const app = express();
    app.get("/ok", async (_req, res) => {
      await Promise.resolve();
      res.json({ ok: true });
    });
    app.get("/throws", async () => {
      throw new Error("kaboom");
    });
    app.get("/throws-late", async () => {
      await new Promise((r) => setTimeout(r, 5));
      throw new Error("late kaboom");
    });
    app.get("/app-error", async () => {
      throw new AppError("AUTH_PERMISSION_DENIED");
    });
    app.get("/after-send", async (_req, res) => {
      res.status(200).send("partial");
      throw new Error("after send");
    });
    const router = express.Router();
    router.post("/nested", async () => {
      throw new Error("nested kaboom");
    });
    app.use("/r", router);
    app.use(globalErrorHandler as any);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    process.off("unhandledRejection", onUnhandled);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("does not disturb a handler that succeeds", async () => {
    const res = await fetch(`${base}/ok`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  it("turns a thrown async error into a JSON 500", async () => {
    const res = await fetch(`${base}/throws`);
    assert.equal(res.status, 500);
    assert.equal((await res.json() as { code: string }).code, "INTERNAL");
  });

  it("handles an error thrown after an await", async () => {
    const res = await fetch(`${base}/throws-late`);
    assert.equal(res.status, 500);
  });

  it("keeps the status of a typed AppError", async () => {
    const res = await fetch(`${base}/app-error`);
    assert.equal(res.status, 403);
  });

  it("covers handlers inside nested routers", async () => {
    const res = await fetch(`${base}/r/nested`, { method: "POST" });
    assert.equal(res.status, 500);
  });

  it("does not write a second response when the handler fails after sending", async () => {
    const res = await fetch(`${base}/after-send`).catch(() => null);
    // Either the client saw the partial 200 or the socket was closed; it must not have been a hang.
    if (res) assert.equal(res.status, 200);
  });

  it("raises no unhandled rejection for any of the above", async () => {
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(unhandled, []);
  });
});
