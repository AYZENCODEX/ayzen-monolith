import { z } from "zod/v4";
import { registerEvent, subscribe } from "../event-bus";
import { acieEngine } from "./engine";
import type { AcieDomainEvent } from "./types";

export * from "./types";
export * from "./store";
export * from "./analysis";
export * from "./engine";

let registered = false;
export function initializeAcie(): void {
  if (registered) return;
  registered = true;
  registerEvent({ type: "acie.observation.received", version: 1, owner: "acie", schema: z.record(z.string(), z.unknown()) });
  registerEvent({ type: "acie.outcome.recorded", version: 1, owner: "acie", schema: z.record(z.string(), z.unknown()) });
  registerEvent({ type: "acie.intelligence.created", version: 1, owner: "acie", schema: z.record(z.string(), z.unknown()) });
  for (const eventType of ["task.created", "task.completed", "task.failed", "job.created", "job.failed", "policy.decision.allowed", "policy.decision.denied", "credit.consumption.created"]) {
    subscribe(eventType, `acie-collector:${eventType}`, async (event) => {
      acieEngine.ingest(event as AcieDomainEvent);
    });
  }
}

initializeAcie();