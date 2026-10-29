import crypto from "node:crypto";
import { assertNonEmpty, SEVERITIES } from "@ayzen/enforcement-core";

export function createGapRegistry({ now = () => new Date().toISOString(), audit = () => {} } = {}) {
  const records = new Map();
  function create(input) {
    const severity = input.severity ?? "medium";
    if (!SEVERITIES.includes(severity)) throw new Error(`Unsupported gap severity: ${severity}`);
    const record = Object.freeze({
      id: input.id ?? crypto.randomUUID(),
      findingCode: assertNonEmpty(input.findingCode, "findingCode"),
      severity,
      owner: assertNonEmpty(input.owner, "gap owner"),
      slaHours: Number.isFinite(input.slaHours) && input.slaHours > 0 ? input.slaHours : 72,
      status: "open",
      remediationWorkflow: assertNonEmpty(input.remediationWorkflow ?? "incident-response", "remediationWorkflow"),
      evidence: input.evidence ?? {},
      createdAt: now(),
      dueAt: new Date(Date.parse(now()) + input.slaHours * 3_600_000).toISOString(),
    });
    records.set(record.id, record);
    audit({ action: "technical_gap.created", gapId: record.id, findingCode: record.findingCode });
    return record;
  }
  function close(id, { evidence, actor = "gap-owner" } = {}) {
    const prior = records.get(id);
    if (!prior) throw new Error(`Unknown gap: ${id}`);
    if (!evidence) throw new Error("Closure evidence is required");
    const record = Object.freeze({ ...prior, status: "closed", closureEvidence: evidence, closedAt: now(), closedBy: actor });
    records.set(id, record);
    audit({ action: "technical_gap.closed", gapId: id, actor });
    return record;
  }
  return Object.freeze({
    create, close, get: (id) => records.get(id), list: () => [...records.values()],
    overdue: (at = now()) => [...records.values()].filter((item) => item.status === "open" && item.dueAt < at),
    open: () => [...records.values()].filter((item) => item.status === "open"),
  });
}