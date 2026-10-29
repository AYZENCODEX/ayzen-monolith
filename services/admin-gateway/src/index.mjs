import { decide } from "@ayzen/policy-contract";

export function createAdminGateway({ services = {}, audit = () => {} } = {}) {
  async function execute({ capability, service, operation, subject, actorType = "user", stepUpAt, ...input } = {}) {
    const policy = decide({ app: "admin", consumer: "admin", capability, subject, actorType, stepUpAt, traceId: input.traceId });
    audit({ action: "admin.operation.decision", capability, service, decision: policy.decision, traceId: policy.traceId });
    if (policy.decision !== "allow") return { status: policy.decision === "conditional" ? 428 : 403, policy };
    if (typeof services[service]?.[operation] !== "function") return { status: 404, error: "OWNING_SERVICE_OPERATION_NOT_FOUND" };
    const result = await services[service][operation](input);
    audit({ action: "admin.operation.completed", capability, service, operation, traceId: policy.traceId });
    return { status: 200, policy, result };
  }
  return Object.freeze({ execute });
}