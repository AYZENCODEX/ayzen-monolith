import {
  validateEventContract,
  validateNotificationContract,
  validateScheduleDefinition,
  validateWorkflowContract,
} from "@ayzen/platform-governance";

export function validatePlatformContract(kind, value) {
  const validators = {
    event: validateEventContract,
    workflow: validateWorkflowContract,
    schedule: validateScheduleDefinition,
    notification: validateNotificationContract,
  };
  if (!validators[kind]) throw new Error(`Unsupported platform contract: ${kind}`);
  return validators[kind](value);
}