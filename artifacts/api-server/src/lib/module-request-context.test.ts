import assert from "node:assert/strict";
import test from "node:test";
import { currentModuleContext, moduleRequestContext, resolveCallerModule, runWithModuleContext } from "./module-request-context";

test("resolveCallerModule: a first-party Origin decides; otherwise the Host does", () => {
  const r = (hostname: string | undefined, origin?: string) => resolveCallerModule({ hostname, origin });
  assert.equal(r("sylo.ayzen.tech"), "sylo", "same-origin call on the module host");
  assert.equal(r("api.ayzen.tech", "https://sylo.ayzen.tech"), "sylo", "SPA on sylo calling the API host cross-origin");
  assert.equal(r("api.ayzen.tech", "https://warde.ayzen.tech"), "warde");
  assert.equal(r("api.ayzen.tech"), null, "API host, no Origin: server-to-server, no module");
  assert.equal(r("ayzen.tech"), null, "central app");
});

test("resolveCallerModule: the Origin can only narrow, never be overridden by Host", () => {
  const r = (hostname: string | undefined, origin?: string) => resolveCallerModule({ hostname, origin });
  assert.equal(r("sylo.ayzen.tech", "https://ayzen.tech"), null, "central Origin on a module Host is NOT treated as that module");
  assert.equal(r("sylo.ayzen.tech", "https://ryft.ayzen.tech"), "ryft", "Origin wins over Host");
  assert.equal(r("sylo.ayzen.tech", "https://evil.example"), null, "foreign Origin never falls back to Host");
  assert.equal(r("sylo.ayzen.tech", "https://sylo.ayzen.tech.evil.com"), null, "lookalike suffix");
  assert.equal(r("sylo.ayzen.tech", "https://evilayzen.tech"), null);
  assert.equal(r("sylo.ayzen.tech", "null"), null, "opaque origin (sandboxed iframe) is not first-party");
  assert.equal(r("sylo.ayzen.tech", "not a url"), null);
  assert.equal(r("sylo.ayzen.tech", "http://sylo.ayzen.tech"), null, "http (non-TLS) origin is not first-party in production");
});

test("context is empty outside a request and scoped to the callback inside it", async () => {
  assert.equal(currentModuleContext(), null);
  const seen = await runWithModuleContext("ryft", async () => {
    const before = currentModuleContext();
    await new Promise((r) => setTimeout(r, 5));
    const after = currentModuleContext();
    const nested = runWithModuleContext(null, () => currentModuleContext());
    return { before, after, nested, restored: currentModuleContext() };
  });
  assert.deepEqual(seen, { before: "ryft", after: "ryft", nested: null, restored: "ryft" });
  assert.equal(currentModuleContext(), null);
});

test("concurrent requests never see each other's module", async () => {
  const ids = ["sylo", "ryft", "fyra", "verve", "skarn", "warde", "wisp", "zynth"] as const;
  const seen = await Promise.all(ids.map((id, i) => runWithModuleContext(id, async () => {
    await new Promise((r) => setTimeout(r, (ids.length - i) * 3));
    return currentModuleContext();
  })));
  assert.deepEqual(seen, [...ids]);
});

test("middleware: sets the context for next(), derived from req.hostname + Origin", async () => {
  const run = (hostname: string, origin?: string) => new Promise<string | null>((resolve) => {
    moduleRequestContext({ hostname, headers: origin ? { origin } : {} } as any, {} as any, () => resolve(currentModuleContext()));
  });
  assert.equal(await run("wisp.ayzen.tech"), "wisp");
  assert.equal(await run("api.ayzen.tech", "https://zynth.ayzen.tech"), "zynth");
  assert.equal(await run("ayzen.tech"), null);
  assert.equal(currentModuleContext(), null, "nothing leaks out of next()");
});
