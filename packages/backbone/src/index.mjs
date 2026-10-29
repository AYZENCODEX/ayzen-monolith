import crypto from "node:crypto";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function id(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

export function createBackboneRuntime({ now = () => new Date().toISOString(), maxAttempts = 3 } = {}) {
  const catalog = new Map();
  const subscriptions = new Map();
  const received = [];
  const processed = new Set();
  const deadLetters = [];
  const archive = [];
  const workflows = new Map();
  const runs = new Map();
  const metrics = { published: 0, delivered: 0, duplicates: 0, failed: 0, workflowRuns: 0 };

  function registerEvent(definition) {
    const type = id(definition.type, "Event type");
    if (!Number.isSafeInteger(definition.version) || definition.version < 1) throw new Error("Event version is required");
    const key = `${type}:v${definition.version}`;
    if (catalog.has(key)) throw new Error("Event schema already registered");
    catalog.set(key, { ...definition, type, key });
    return clone(catalog.get(key));
  }

  function subscribe({ eventType, consumer, handler, priority = 0, retry = maxAttempts } = {}) {
    id(eventType, "Event type");
    id(consumer, "Consumer");
    if (typeof handler !== "function") throw new Error("Consumer handler is required");
    const list = subscriptions.get(eventType) ?? [];
    list.push({ consumer, handler, priority, retry });
    list.sort((a, b) => b.priority - a.priority);
    subscriptions.set(eventType, list);
    return () => subscriptions.set(eventType, list.filter((item) => item.handler !== handler));
  }

  async function publish(envelope, { idempotencyKey } = {}) {
    if (!envelope?.eventId || !envelope?.eventType || !envelope?.traceId || !envelope?.correlationId) throw new Error("Canonical event envelope is required");
    const duplicateKey = idempotencyKey ?? envelope.eventId;
    if (received.some((item) => item.duplicateKey === duplicateKey)) {
      metrics.duplicates += 1;
      return { ...clone(envelope), duplicate: true };
    }
    const stored = { ...clone(envelope), duplicateKey, receivedAt: now() };
    received.push(stored);
    archive.push(stored);
    metrics.published += 1;
    for (const consumer of subscriptions.get(envelope.eventType) ?? []) {
      const processKey = `${envelope.eventId}:${consumer.consumer}`;
      if (processed.has(processKey)) continue;
      let delivered = false;
      let lastError;
      for (let attempt = 1; attempt <= consumer.retry; attempt += 1) {
        try {
          await consumer.handler(clone(envelope));
          delivered = true;
          processed.add(processKey);
          metrics.delivered += 1;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!delivered) {
        metrics.failed += 1;
        deadLetters.push({ envelope: clone(envelope), consumer: consumer.consumer, error: String(lastError), attempts: consumer.retry, createdAt: now() });
      }
    }
    return clone(envelope);
  }

  function registerWorkflow(definition) {
    const workflowId = id(definition.id, "Workflow id");
    if (!Array.isArray(definition.steps) || !definition.steps.length) throw new Error("Workflow steps are required");
    if (workflows.has(workflowId) && workflows.get(workflowId).version >= definition.version) throw new Error("Workflow version must advance");
    workflows.set(workflowId, { ...definition, id: workflowId, version: definition.version ?? 1 });
    return clone(workflows.get(workflowId));
  }

  async function startWorkflow({ workflowId, input = {}, context = {} } = {}) {
    const definition = workflows.get(id(workflowId, "Workflow id"));
    if (!definition) throw new Error("Workflow is not registered");
    const run = { id: `run:${crypto.randomUUID()}`, workflowId, status: "running", stepIndex: 0, input: clone(input), context: clone(context), history: [], startedAt: now() };
    runs.set(run.id, run);
    metrics.workflowRuns += 1;
    return executeWorkflow(run);
  }

  async function executeWorkflow(run) {
    const definition = workflows.get(run.workflowId);
    while (run.stepIndex < definition.steps.length && run.status === "running") {
      const step = definition.steps[run.stepIndex];
      try {
        if (typeof step.run !== "function") throw new Error(`Workflow step ${step.id} has no runner`);
        const result = await step.run({ input: clone(run.input), context: clone(run.context), history: clone(run.history) });
        run.history.push({ step: step.id, status: "completed", result: clone(result), at: now() });
        run.stepIndex += 1;
      } catch (error) {
        run.status = "failed";
        run.history.push({ step: step.id, status: "failed", error: String(error), at: now() });
      }
    }
    if (run.status === "running") {
      run.status = "completed";
      run.completedAt = now();
    }
    return clone(run);
  }

  return Object.freeze({
    registerEvent,
    eventCatalog: () => [...catalog.values()].map(clone),
    subscribe,
    publish,
    registerWorkflow,
    startWorkflow,
    getRun: (runId) => clone(runs.get(runId)),
    deadLetters: () => deadLetters.map(clone),
    replay: async ({ eventType, consumer } = {}) => {
      const events = archive.filter((event) => (!eventType || event.eventType === eventType));
      for (const envelope of events) {
        const handlers = subscriptions.get(envelope.eventType) ?? [];
        for (const item of handlers) if (!consumer || item.consumer === consumer) processed.delete(`${envelope.eventId}:${item.consumer}`);
        await publish(envelope, { idempotencyKey: `replay:${envelope.eventId}:${consumer ?? "all"}` });
      }
      return events.length;
    },
    health: () => ({ ...metrics, eventCatalog: catalog.size, subscriptions: [...subscriptions.values()].flat().length, deadLetters: deadLetters.length, archived: archive.length }),
  });
}