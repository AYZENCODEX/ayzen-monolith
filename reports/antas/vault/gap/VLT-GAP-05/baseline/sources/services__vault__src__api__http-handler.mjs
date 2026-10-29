import {
  readJsonBody,
  tenantScopeFromHeaders,
  requireTenantScope,
} from "@ayzen/service-runtime";
import { actorFrom } from "../security/access.mjs";
import { createSecretApplication } from "../application/secret-service.mjs";

export function createVaultHttpHandler(dependencies) {
  const application = createSecretApplication(dependencies);

  return async function handle({ req, url, requestId, auth }) {
    const tenant = tenantScopeFromHeaders(req.headers, { auth });
    if (url.pathname === "/api/vault/secrets" && req.method === "GET") {
      return { status: 200, body: { items: application.list({ tenant }) } };
    }
    if (url.pathname === "/api/vault/secrets" && req.method === "POST") {
      requireTenantScope(tenant);
      const body = await readJsonBody(req);
      return application.create({ body, tenant, auth: actorFrom(auth), requestId });
    }
    const secretMatch = url.pathname.match(/^\/api\/vault\/secrets\/([^/]+)$/);
    if (secretMatch && req.method === "GET") {
      requireTenantScope(tenant);
      return application.reveal({
        id: secretMatch[1],
        tenant,
        auth: actorFrom(auth),
        request: req,
        requestId,
      });
    }
    if (url.pathname === "/internal/audit" && req.method === "GET") {
      return { status: 200, body: { items: dependencies.audit.list() } };
    }
    return { status: 404, body: { error: "Route not found", code: "NOT_FOUND" } };
  };
}
