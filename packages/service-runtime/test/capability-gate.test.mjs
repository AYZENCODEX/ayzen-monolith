import test from "node:test";
import assert from "node:assert/strict";
import { createServiceServer } from "../src/index.mjs";

// Phase H9.1/H9.2 — before H9.1, `createServiceServer`'s only gate
// (authorizeServiceCapability, H4) proved identity *presence* for a
// gated route and stopped there ("IDENTITY_PRESENT_SCOPE_NOT_VERIFIED"):
// any authenticated caller passed regardless of scope, role, or step-up.
// H9.1 added the fine-grained authorizeCapability() stage that actually
// checks those. H9.2 gives that stage its own independent kill switch,
// CAPABILITY_AUTHZ_GATE, defaulting to "enforce" (report remains an explicit
// migration mode). These tests boot a real
// HTTP server via createServiceServer (no mocks of the gate itself)
// against real routes from @ayzen/capabilities' registry
// (finance.list-accounts: scope "finance:read", not sensitive;
// finance.post-transaction: scope "finance:write", sensitive) and drive
// it with real requests, the same way H8.4's owner-enforcement gate was
// verified against a really-booted services/workflow.

async function startServer({ authenticate }) {
  const { start } = createServiceServer({
    service: "test-finance",
    port: 0,
    authenticate,
    rateLimit: { windowMs: 60_000, max: 10_000 },
    handle: async ({ url }) => ({ status: 200, body: { ok: true, path: url.pathname } }),
  });
  const server = start();
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  return {
    port,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function withEnv(vars, fn) {
  const previous = {};
  for (const key of Object.keys(vars)) {
    previous[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(previous)) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    });
}

test("a capability route with valid auth but a missing scope is denied (403, MISSING_SCOPE) once CAPABILITY_AUTHZ_GATE is enforced", async () => {
  const { port, close } = await startServer({
    authenticate: async () => ({ sub: "user:1", actorType: "user", scopes: [], roles: [] }),
  });
  try {
    await withEnv({ SERVICE_CAPABILITY_GATE: undefined, CAPABILITY_AUTHZ_GATE: "enforce" }, async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/finance/accounts`);
      const body = await response.json();
      assert.equal(response.status, 403);
      assert.equal(body.code, "MISSING_SCOPE");
      assert.equal(body.capability, "finance.list-accounts");
    });
  } finally {
    await close();
  }
});

test("the same route with the required scope present succeeds under CAPABILITY_AUTHZ_GATE=enforce", async () => {
  const { port, close } = await startServer({
    authenticate: async () => ({ sub: "user:1", actorType: "user", scopes: ["finance:read"], roles: [] }),
  });
  try {
    await withEnv({ SERVICE_CAPABILITY_GATE: undefined, CAPABILITY_AUTHZ_GATE: "enforce" }, async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/finance/accounts`);
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
    });
  } finally {
    await close();
  }
});

test("a sensitive capability with the right scope but no recent step-up is denied (428, STEP_UP_REQUIRED) under enforce", async () => {
  const { port, close } = await startServer({
    authenticate: async () => ({ sub: "user:1", actorType: "user", scopes: ["finance:write"], roles: [] }),
  });
  try {
    await withEnv({ SERVICE_CAPABILITY_GATE: undefined, CAPABILITY_AUTHZ_GATE: "enforce" }, async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/finance/accounts/acc-1/transactions`, { method: "POST" });
      const body = await response.json();
      assert.equal(response.status, 428);
      assert.equal(body.code, "STEP_UP_REQUIRED");
    });
  } finally {
    await close();
  }
});

test("a sensitive capability with the right scope and a recent step-up succeeds under enforce", async () => {
  const { port, close } = await startServer({
    authenticate: async () => ({ sub: "user:1", actorType: "user", scopes: ["finance:write"], roles: [], stepUpAt: new Date().toISOString() }),
  });
  try {
    await withEnv({ SERVICE_CAPABILITY_GATE: undefined, CAPABILITY_AUTHZ_GATE: "enforce" }, async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/finance/accounts/acc-1/transactions`, { method: "POST" });
      assert.equal(response.status, 200);
    });
  } finally {
    await close();
  }
});

test("an internal service-to-service caller is trusted and skips the fine-grained scope check entirely, even under enforce", async () => {
  // Mirrors createServiceIdentity()'s own shape: actorType "service", no
  // domain scopes at all — authorizeServiceCapability's INTERNAL_SERVICE_
  // TRUSTED path, which the fine-grained gate deliberately does not
  // re-derive a scope decision for (see this file's own header comment
  // in packages/service-runtime/src/index.mjs).
  const { port, close } = await startServer({
    authenticate: async () => ({ subject: "service:worker", actorType: "service", scopes: [] }),
  });
  try {
    await withEnv({ SERVICE_CAPABILITY_GATE: undefined, CAPABILITY_AUTHZ_GATE: "enforce" }, async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/finance/accounts`);
      assert.equal(response.status, 200);
    });
  } finally {
    await close();
  }
});

test("H9.2: with CAPABILITY_AUTHZ_GATE unset, the default is 'enforce' — a missing scope is blocked", async () => {
  const { port, close } = await startServer({
    authenticate: async () => ({ sub: "user:1", actorType: "user", scopes: [], roles: [] }),
  });
  try {
    await withEnv({ SERVICE_CAPABILITY_GATE: undefined, CAPABILITY_AUTHZ_GATE: undefined }, async () => {
       const response = await fetch(`http://127.0.0.1:${port}/api/finance/accounts`);
       const body = await response.json();
       assert.equal(response.status, 403);
       assert.equal(body.code, "MISSING_SCOPE");
    });
  } finally {
    await close();
  }
});

test("H9.2: an unrecognized CAPABILITY_AUTHZ_GATE value fails toward the safe 'enforce' default", async () => {
  const { port, close } = await startServer({
    authenticate: async () => ({ sub: "user:1", actorType: "user", scopes: [], roles: [] }),
  });
  try {
    await withEnv({ SERVICE_CAPABILITY_GATE: undefined, CAPABILITY_AUTHZ_GATE: "not-a-real-mode" }, async () => {
       const response = await fetch(`http://127.0.0.1:${port}/api/finance/accounts`);
       const body = await response.json();
       assert.equal(response.status, 403);
       assert.equal(body.code, "MISSING_SCOPE");
    });
  } finally {
    await close();
  }
});

test("H9.2: CAPABILITY_AUTHZ_GATE=off skips the fine-grained gate even while SERVICE_CAPABILITY_GATE=enforce", async () => {
  const { port, close } = await startServer({
    authenticate: async () => ({ sub: "user:1", actorType: "user", scopes: ["finance:write"], roles: [] }),
  });
  try {
    await withEnv({ SERVICE_CAPABILITY_GATE: "enforce", CAPABILITY_AUTHZ_GATE: "off" }, async () => {
      // Sensitive capability, no step-up — would be a 428 under "enforce",
      // but the fine-grained gate is fully off, so it goes through, while
      // the coarse gate (still enforced) still requires the identity it
      // already has.
      const response = await fetch(`http://127.0.0.1:${port}/api/finance/accounts/acc-1/transactions`, { method: "POST" });
      assert.equal(response.status, 200);
    });
  } finally {
    await close();
  }
});

test("H9.2: the two gates are independent — SERVICE_CAPABILITY_GATE=report doesn't stop CAPABILITY_AUTHZ_GATE=enforce from blocking a missing scope", async () => {
  const { port, close } = await startServer({
    authenticate: async () => ({ sub: "user:1", actorType: "user", scopes: [], roles: [] }),
  });
  try {
    await withEnv({ SERVICE_CAPABILITY_GATE: "report", CAPABILITY_AUTHZ_GATE: "enforce" }, async () => {
      // Identity IS present, so the coarse gate's own decision is "allow"
      // (IDENTITY_PRESENT_SCOPE_NOT_VERIFIED) regardless of its own
      // report/enforce mode — that mode only ever changes what happens on
      // a coarse *deny* (no identity at all), which doesn't apply here.
      // The fine-grained gate still runs off gateDecision.capability and,
      // under its own independent "enforce", blocks the missing scope.
      const response = await fetch(`http://127.0.0.1:${port}/api/finance/accounts`);
      const body = await response.json();
      assert.equal(response.status, 403);
      assert.equal(body.code, "MISSING_SCOPE");
    });
  } finally {
    await close();
  }
});

test("SERVICE_CAPABILITY_GATE=report logs the coarse denial but does not block the request", async () => {
  const { port, close } = await startServer({
    authenticate: async () => ({ sub: "user:1", actorType: "user", scopes: [], roles: [] }),
  });
  try {
    // CAPABILITY_AUTHZ_GATE is pinned to "off" so this test isolates the coarse
    // gate's report mode. Left unset it defaults to "enforce" (H9.2) and the
    // fine-grained gate would correctly return 403 MISSING_SCOPE for scopes: [].
    await withEnv({ SERVICE_CAPABILITY_GATE: "report", CAPABILITY_AUTHZ_GATE: "off" }, async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/finance/accounts`);
      assert.equal(response.status, 200);
    });
  } finally {
    await close();
  }
});

test("SERVICE_CAPABILITY_GATE=off skips both gate stages entirely, regardless of CAPABILITY_AUTHZ_GATE", async () => {
  const { port, close } = await startServer({
    authenticate: async () => ({ sub: "user:1", actorType: "user", scopes: [], roles: [] }),
  });
  try {
    await withEnv({ SERVICE_CAPABILITY_GATE: "off", CAPABILITY_AUTHZ_GATE: "enforce" }, async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/finance/accounts`);
      assert.equal(response.status, 200);
    });
  } finally {
    await close();
  }
});

test("a request with no auth at all is still denied by the coarse gate before the fine-grained gate ever runs", async () => {
  const { port, close } = await startServer({ authenticate: async () => undefined });
  try {
    await withEnv({ SERVICE_CAPABILITY_GATE: undefined, CAPABILITY_AUTHZ_GATE: undefined }, async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/finance/accounts`);
      const body = await response.json();
      assert.equal(response.status, 401);
      assert.equal(body.code, "AUTHENTICATED_SUBJECT_REQUIRED");
    });
  } finally {
    await close();
  }
});
