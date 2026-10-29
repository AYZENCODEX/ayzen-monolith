const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_FIELDS = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const definitions = [
  ["users", "identity", ["admin:data:read"], ["admin:data:write"], false, false],
  ["workspaces", "workspace", ["admin:data:read"], ["admin:data:write"], false, false],
  ["finance_accounts", "finance", ["admin:data:read"], ["admin:data:write"], false, true],
  ["vault_secrets", "vault", ["admin:data:read"], [], true, false],
  ["mail_messages", "mail", ["admin:data:read"], ["admin:data:write"], false, false],
  ["workflow_executions", "workflow", ["admin:data:read"], ["admin:data:write"], false, true],
  ["audit_events", "audit", ["admin:audit"], [], true, false],
  ["technical_gaps", "intelligence", ["admin:read"], ["admin:remediate"], false, false],
];

export const ADMIN_DATA_RESOURCES = Object.freeze(definitions.map(([resource, owner, readScopes, writeScopes, sensitive, transactionRequired]) => Object.freeze({
  resource,
  owner,
  readScopes: Object.freeze(readScopes),
  writeScopes: Object.freeze(writeScopes),
  sensitive,
  transactionRequired,
  deleteEnabled: false,
})));

const byResource = new Map(ADMIN_DATA_RESOURCES.map((item) => [item.resource, item]));

function hasScope(auth, scopes) {
  const granted = new Set([...(auth?.scopes ?? []), ...(typeof auth?.scope === "string" ? auth.scope.split(/\s+/) : [])]);
  return scopes.some((scope) => granted.has(scope));
}

export function getAdminResource(resource) {
  if (!IDENTIFIER.test(String(resource ?? ""))) throw new Error("Invalid admin resource");
  return byResource.get(resource);
}

export function listAdminResources() {
  return [...ADMIN_DATA_RESOURCES];
}

export function authorizeAdminDataAction({ auth, resource, action, breakGlass = false } = {}) {
  const definition = getAdminResource(resource);
  if (!definition) return { allowed: false, code: "ADMIN_RESOURCE_NOT_REGISTERED" };
  if (action === "read") {
    if (definition.sensitive && !breakGlass && !hasScope(auth, definition.readScopes)) return { allowed: false, code: "ADMIN_SCOPE_REQUIRED" };
    if (!hasScope(auth, definition.readScopes) && !breakGlass) return { allowed: false, code: "ADMIN_SCOPE_REQUIRED" };
    return { allowed: true, definition };
  }
  if (action === "write") {
    if (!hasScope(auth, definition.writeScopes) && !breakGlass) return { allowed: false, code: "ADMIN_SCOPE_REQUIRED" };
    return { allowed: true, definition };
  }
  if (action === "delete") return { allowed: false, code: "ADMIN_DELETE_DISABLED" };
  return { allowed: false, code: "ADMIN_ACTION_NOT_SUPPORTED" };
}

export function validateAdminQuery({ resource, fields = [], filters = {}, limit = 50, cursor } = {}) {
  const definition = getAdminResource(resource);
  if (!definition) throw new Error("Admin resource is not registered");
  if (!Array.isArray(fields) || fields.some((field) => typeof field !== "string" || !SAFE_FIELDS.test(field))) throw new Error("Admin query fields are invalid");
  if (!filters || typeof filters !== "object" || Array.isArray(filters) || Object.keys(filters).some((field) => !SAFE_FIELDS.test(field))) throw new Error("Admin query filters are invalid");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Admin query limit must be between 1 and 100");
  if (cursor !== undefined && (typeof cursor !== "string" || cursor.length > 256)) throw new Error("Admin query cursor is invalid");
  return { definition, resource, fields: [...fields], filters: { ...filters }, limit, ...(cursor ? { cursor } : {}) };
}

export function validateAdminMutation({ resource, operation = "update", changes, confirmation, transactionId } = {}) {
  const definition = getAdminResource(resource);
  if (!definition) throw new Error("Admin resource is not registered");
  if (!["insert", "update"].includes(operation)) throw new Error("Admin mutations support insert or update only");
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new Error("Admin mutation changes are required");
  if (Object.keys(changes).some((field) => !SAFE_FIELDS.test(field))) throw new Error("Admin mutation contains an invalid field");
  if (confirmation !== true) throw new Error("Explicit mutation confirmation is required");
  if (definition.transactionRequired && (typeof transactionId !== "string" || !IDENTIFIER.test(transactionId))) throw new Error("Transaction ID is required for this resource");
  return { definition, resource, operation, changes: { ...changes }, transactionId };
}

export function createAdminDataAccess({ provider } = {}) {
  if (!provider || typeof provider.query !== "function" || typeof provider.mutate !== "function") {
    throw new Error("An explicit Admin Data provider is required");
  }
  return Object.freeze({
    listResources: listAdminResources,
    async query(input) {
      const request = validateAdminQuery(input);
      return provider.query(request);
    },
    async mutate(input) {
      const request = validateAdminMutation(input);
      return provider.mutate(request);
    },
  });
}