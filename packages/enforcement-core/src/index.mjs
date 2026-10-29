import crypto from "node:crypto";

export const SEVERITIES = Object.freeze(["critical", "high", "medium", "low", "info"]);

export function assertNonEmpty(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

export function assertId(value, label = "id") {
  const id = assertNonEmpty(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new Error(`${label} is invalid`);
  return id;
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function sha256(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex");
}

export function nowIso(now = () => new Date().toISOString()) {
  return now();
}

export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return typeof value === "string" && /(secret|token|password|private[_-]?key|credential)/i.test(value) ? "[REDACTED]" : value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    /(secret|token|password|private[_-]?key|credential|authorization)/i.test(key) ? "[REDACTED]" : redactSecrets(item),
  ]));
}

export function createRegistry({ id = "registry", key = "id", required = ["owner"], now = () => new Date().toISOString() } = {}) {
  const records = new Map();
  const findings = [];
  function validate(input) {
    if (!input || typeof input !== "object") throw new Error(`${id} record must be an object`);
    assertId(input[key], `${id}.${key}`);
    for (const field of required) if (input[field] === undefined || input[field] === null || input[field] === "") throw new Error(`${id}.${field} is required`);
    return Object.freeze({ ...input, registeredAt: input.registeredAt ?? now() });
  }
  function register(input) {
    const record = validate(input);
    if (records.has(record[key])) throw new Error(`Duplicate ${id} record: ${record[key]}`);
    records.set(record[key], record);
    return record;
  }
  return Object.freeze({
    id,
    register,
    get: (recordId) => records.get(recordId),
    list: () => [...records.values()],
    has: (recordId) => records.has(recordId),
    findings: () => [...findings],
    addFinding: (finding) => {
      const normalized = Object.freeze({ severity: finding.severity ?? "medium", ...finding, recordedAt: finding.recordedAt ?? now() });
      findings.push(normalized);
      return normalized;
    },
    status: () => findings.some((item) => item.severity === "critical" || item.severity === "high") ? "BLOCKED" : "READY",
  });
}

export function createEvidence({ phase, subject, status = "passed", evidence = {}, owner = "platform", now = () => new Date().toISOString() } = {}) {
  const record = {
    evidenceId: crypto.randomUUID(),
    phase: assertNonEmpty(String(phase), "phase"),
    subject: assertNonEmpty(subject, "subject"),
    status,
    owner: assertNonEmpty(owner, "owner"),
    evidence: redactSecrets(evidence),
    recordedAt: now(),
  };
  return Object.freeze({ ...record, digest: sha256(record) });
}

export function compareObservedEdges(expected = [], observed = []) {
  const expectedKeys = new Set(expected.map((edge) => `${edge.from}->${edge.to}`));
  const observedKeys = new Set(observed.map((edge) => `${edge.from}->${edge.to}`));
  return {
    missing: expected.filter((edge) => !observedKeys.has(`${edge.from}->${edge.to}`)),
    unexpected: observed.filter((edge) => !expectedKeys.has(`${edge.from}->${edge.to}`)),
    complete: expected.every((edge) => observedKeys.has(`${edge.from}->${edge.to}`)),
  };
}