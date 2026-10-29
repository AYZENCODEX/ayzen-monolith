import { createConfiguredAuthenticator, createServiceServer } from "@ayzen/service-runtime";
import { contextHeaders } from "@ayzen/tracing";

const backendUrl = (process.env.IDENTITY_BACKEND_URL ?? process.env.MONOLITH_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");

async function handle({ req, url, requestId, context, signal }) {
  const bodyChunks = [];
  if (req.method !== "GET" && req.method !== "HEAD") {
    for await (const chunk of req) bodyChunks.push(chunk);
  }
  const destination = new URL(`${url.pathname}${url.search}`, `${backendUrl}/`);
  const headers = { ...req.headers, "x-ayzen-service": "identity-service", ...contextHeaders({ ...context, requestId }) };
  delete headers.host;
  delete headers.connection;
  const response = await fetch(destination, {
    method: req.method,
    headers,
    body: bodyChunks.length ? Buffer.concat(bodyChunks) : undefined,
    redirect: "manual",
    signal,
  });
  const responseBody = Buffer.from(await response.arrayBuffer());
  return { status: response.status, body: JSON.parse(responseBody.toString("utf8")) };
}

createServiceServer({
  service: "identity",
  displayName: "Identity",
  port: Number(process.env.PORT ?? 8100),
  routePrefixes: ["/api/auth", "/oidc", "/.well-known"],
  handle,
  authenticate: createConfiguredAuthenticator({ service: "identity" }),
  domain: "identity",
  owner: "Identity",
  ownedResources: ["users", "credentials", "sessions", "mfa", "oidc_clients"],
  // Phase H12.1 — this service is a pure HTTP proxy to the monolith (see
  // `handle()` above): every request is forwarded verbatim and the
  // response relayed back, with no business logic and no event bus access
  // of its own. It emits nothing today, so this list — surfaced verbatim
  // on GET /internal/manifest and GET /health by
  // @ayzen/service-runtime's createServiceServer — must not claim
  // otherwise. `packages/domain-boundaries`'s "identity" domain contract
  // still declares these five as the *target*-state contract (that's
  // intentional and should stay as-is); this field is the *current,
  // running* service's claim, which is a different thing and was wrong.
  // See docs/changes/CHANGES_H4_EVENT_WORKFLOW_ENFORCEMENT_PHASE_H12_1.md
  // for the cutover plan that gets this list populated for real.
  emittedEvents: [],
  rollbackStrategy: "disable IDENTITY_SERVICE_URL and return to monolith",
  // Identity is intentionally foundational and remains monolith-backed until
  // its auth/session write path has an independent cutover plan. It does not
  // publish or consume events today, so it must not claim an event-bus
  // dependency merely because other extracted services do.
  dependencies: { backendConfiguration: Boolean(backendUrl) },
}).start();