import { assertNonEmpty } from "@ayzen/enforcement-core";
import { decide } from "@ayzen/policy-contract";

export function createAppAccessGateway({ matrix = [], audit = () => {} } = {}) {
  const edges = new Map(matrix.map((entry) => [`${entry.from}->${entry.to}`, Object.freeze({ ...entry })]));
  function edge(from, to) {
    return edges.get(`${from}->${to}`);
  }
  function authorize({ from, to, action, capability, dataScope, subject, traceId } = {}) {
    assertNonEmpty(from, "source app");
    assertNonEmpty(to, "target app");
    const permission = edge(from, to);
    if (!permission) {
      const result = { decision: "deny", reason: "CROSS_APP_EDGE_NOT_REGISTERED", from, to, action, capability, dataScope, traceId };
      audit(result);
      return result;
    }
    if (permission.actions && !permission.actions.includes(action)) {
      const result = { decision: "deny", reason: "CROSS_APP_ACTION_NOT_ALLOWED", from, to, action };
      audit(result);
      return result;
    }
    if (permission.dataScopes && dataScope && !permission.dataScopes.includes(dataScope)) {
      const result = { decision: "deny", reason: "CROSS_APP_DATA_SCOPE_NOT_ALLOWED", from, to, dataScope };
      audit(result);
      return result;
    }
    const policy = capability
      ? decide({ app: to, consumer: "service", capability, subject, traceId })
      : { decision: "allow", reason: "REGISTERED_CROSS_APP_EDGE" };
    const result = { ...policy, from, to, dataScope };
    audit(result);
    return result;
  }
  return Object.freeze({ authorize, edge, list: () => [...edges.values()], matrix: () => [...edges.values()] });
}

export function validateCrossAppMatrix(matrix = []) {
  const errors = [];
  const seen = new Set();
  for (const item of matrix) {
    const key = `${item.from}->${item.to}`;
    if (seen.has(key)) errors.push({ code: "DUPLICATE_EDGE", key });
    seen.add(key);
    for (const field of ["from", "to", "owner"]) if (!item[field]) errors.push({ code: "MISSING_FIELD", key, field });
    if (!Array.isArray(item.actions) || item.actions.length === 0) errors.push({ code: "NO_ACTIONS", key });
  }
  return { valid: errors.length === 0, errors };
}