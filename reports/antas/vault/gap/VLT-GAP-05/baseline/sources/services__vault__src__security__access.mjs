import { verifyStepUpToken } from "@ayzen/auth-client";

export function actorFrom(auth) {
  return auth ? { subject: auth.sub ?? auth.subject, actorType: auth.actorType ?? "user" } : undefined;
}

export function createVaultAccess() {
  const consumedStepUps = new Set();

  return {
    consumedStepUps,
    verifyReveal(request, { auth, tenant }) {
      return verifyStepUpToken(request.headers["x-step-up-token"], {
        subject: auth?.sub ?? auth?.subject,
        purpose: "vault.reveal",
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
        consumed: consumedStepUps,
      });
    },
  };
}
