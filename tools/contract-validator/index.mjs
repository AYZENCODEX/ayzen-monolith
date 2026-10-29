import { validatePlatformContract } from "../../packages/contracts/src/platform.mjs";

export function validateContracts({ events = [], workflows = [], schedules = [], notifications = [] } = {}) {
  const errors = [];
  const validate = (kind, values) => values.forEach((value, index) => {
    try { validatePlatformContract(kind, value); }
    catch (error) { errors.push({ kind, index, id: value?.id, message: error.message }); }
  });
  validate("event", events);
  validate("workflow", workflows);
  validate("schedule", schedules);
  validate("notification", notifications);
  return { valid: errors.length === 0, errors };
}