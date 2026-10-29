const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

export function defineApiContract({
  id,
  version = 1,
  method,
  path,
  request = {},
  response = {},
  errors = [],
  auth = "user",
  permission,
  idempotency = false,
} = {}) {
  const contract = {
    id: requiredString(id, "API contract id"),
    version,
    method: requiredString(method, "API method").toUpperCase(),
    path: requiredString(path, "API path"),
    request,
    response,
    errors: [...new Set(errors.map((error) => requiredString(error, "API error")))],
    auth: requiredString(auth, "API auth"),
    ...(permission ? { permission: requiredString(permission, "API permission") } : {}),
    idempotency: Boolean(idempotency),
  };
  if (!METHODS.has(contract.method)) throw new Error(`Unsupported API method: ${contract.method}`);
  if (!contract.path.startsWith("/")) throw new Error("API path must start with /");
  if (!Number.isSafeInteger(contract.version) || contract.version < 1) throw new Error("API version must be a positive integer");
  return Object.freeze(contract);
}

export function assertApiContract(contract) {
  return defineApiContract(contract);
}

export function createApiRegistry(contracts = []) {
  const entries = contracts.map(assertApiContract);
  const ids = new Set();
  for (const contract of entries) {
    if (ids.has(contract.id)) throw new Error(`Duplicate API contract: ${contract.id}`);
    ids.add(contract.id);
  }
  return Object.freeze({
    list: () => [...entries],
    get: (id) => entries.find((contract) => contract.id === id),
    resolve: (method, path) => entries.find((contract) => contract.method === String(method).toUpperCase() && contract.path === path),
  });
}