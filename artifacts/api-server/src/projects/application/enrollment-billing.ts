/**
 * projects/application/enrollment-billing.ts
 * Credit billing for project enrollments (PRJ-07). Single enroll, team enroll and bulk enroll all charge the
 * same metered action, `workspace.project_use`, to the user who performs the action, once per enrollment row
 * actually created, after the write commits. Before PRJ-07 only single enroll charged; team and bulk enroll were free.
 *
 * Policy, matching single enroll: the balance is checked BEFORE writing (here for the whole quantity, because
 * chargeCredits charges nothing when the balance is too low) and the charge happens AFTER the writes. If the charge
 * still fails (a concurrent spend), the enrollments stay and the response reports `_credits: null`, exactly as
 * single enroll does; nothing is rolled back.
 */
import { chargeCredits, hasCreditBalance } from "../../services/credit-meter";

export const ENROLL_CREDIT_ACTION = "workspace.project_use";

export type EnrollCreditCheck =
  | { ok: true }
  | { ok: false; body: { error: string; code: string; action: string; label: string; cost: number; quantity: number; required: number; balance: number; topUp: { method: string; url: string } } };

/** Pre-flight: can `userId` afford `quantity` enrollments? Quantity 0 always passes. */
export async function checkEnrollCredits(userId: number, quantity: number): Promise<EnrollCreditCheck> {
  if (quantity <= 0) return { ok: true };
  const check = await hasCreditBalance(userId, ENROLL_CREDIT_ACTION, quantity);
  if (check.ok) return { ok: true };
  return {
    ok: false,
    body: {
      error: "Out of credits",
      code: "OUT_OF_CREDITS",
      action: check.action.key,
      label: check.action.label,
      cost: check.action.cost,
      quantity,
      required: check.action.cost * quantity,
      balance: check.balance,
      topUp: { method: "POST", url: "/api/credits/purchase" },
    },
  };
}

/** Charge for `quantity` created enrollments. Returns the `_credits` response field (null when nothing was charged). */
export async function chargeEnrollCredits(userId: number, quantity: number): Promise<{ charged: number; newBalance: number } | null> {
  if (quantity <= 0) return null;
  const charge = await chargeCredits(userId, ENROLL_CREDIT_ACTION, { quantity });
  return charge.ok ? { charged: charge.charged, newBalance: charge.newBalance } : null;
}
