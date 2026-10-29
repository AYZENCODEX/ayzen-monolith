export function createEventOperations({ maxAttempts = 5, audit = () => {} } = {}) {
  const deadLetters = [];
  const checkpoints = new Map();
  function recordFailure({ envelope, consumerGroup, error, attempts = 1 }) {
    const item = { id: `${envelope.eventId}:${consumerGroup}`, envelope, consumerGroup, attempts, error: String(error?.message ?? error), recordedAt: new Date().toISOString() };
    if (attempts >= maxAttempts) {
      deadLetters.push(item);
      audit({ action: "event.dead_lettered", item });
    }
    return item;
  }
  function checkpoint(consumerGroup, position) {
    const prior = checkpoints.get(consumerGroup);
    if (prior !== undefined && position < prior) throw new Error("Event checkpoint must be monotonic");
    checkpoints.set(consumerGroup, position);
    return position;
  }
  function replay({ id, approvedBy, reason }) {
    if (!approvedBy || !reason) throw new Error("Operator approval and replay reason are required");
    const item = deadLetters.find((entry) => entry.id === id);
    if (!item) throw new Error("Dead letter not found");
    audit({ action: "event.replayed", id, approvedBy, reason });
    return { ...item, replayedAt: new Date().toISOString(), approvedBy };
  }
  return Object.freeze({ recordFailure, checkpoint, replay, deadLetters: () => [...deadLetters], checkpoints: () => new Map(checkpoints) });
}

/**
 * Phase 13/14 operator plane. The original helper above remains compatible
 * with the event client; this additive plane adds lag, retention, poison
 * quarantine and producer/consumer compatibility without creating another bus.
 */
export function createEventOperationsPlane({ maxAttempts = 5, retentionMs = 30 * 86_400_000, audit = () => {}, decideReplay = () => true, now = () => Date.now() } = {}) {
  const consumers = new Map();
  const failures = new Map();
  const replayed = new Set();
  function observeConsumer(group, { position = 0, highWatermark = position, updatedAt = now() } = {}) {
    consumers.set(group, { group, position, highWatermark, lag: Math.max(0, highWatermark - position), updatedAt });
    return consumers.get(group);
  }
  function fail(envelope, group, error) {
    const key = `${envelope.eventId}:${group}`;
    const prior = failures.get(key) ?? { attempts: 0, firstSeenAt: now() };
    const item = { ...prior, id: key, eventId: envelope.eventId, group, error: String(error?.message ?? error), attempts: prior.attempts + 1, updatedAt: now(), poisoned: prior.attempts + 1 >= maxAttempts };
    failures.set(key, item);
    if (item.poisoned) audit({ action: "event.poison.quarantined", ...item });
    return item;
  }
  function replay(id, { approvedBy, reason, dryRun = false, scope = "event:replay" } = {}) {
    if (!approvedBy || !reason || scope !== "event:replay" || !decideReplay({ approvedBy, id })) throw new Error("Authorized operator approval, replay scope, and reason are required");
    const item = [...failures.values()].find((entry) => entry.id === id);
    if (!item) throw new Error(`Unknown event failure: ${id}`);
    if (!dryRun) replayed.add(id);
    audit({ action: dryRun ? "event.replay.dry_run" : "event.replayed", id, approvedBy, reason });
    return { ...item, dryRun, replayed: !dryRun };
  }
  function prune() {
    const cutoff = now() - retentionMs;
    for (const [id, item] of failures) if (item.updatedAt < cutoff) failures.delete(id);
  }
  return Object.freeze({
    observeConsumer,
    fail,
    replay,
    prune,
    consumerHealth: () => [...consumers.values()],
    lag: (group) => consumers.get(group)?.lag ?? 0,
    poison: () => [...failures.values()].filter((item) => item.poisoned),
    failures: () => [...failures.values()],
    replayed: () => [...replayed],
  });
}

export function checkEventCompatibility(producer, consumer) {
  if (producer.eventType !== consumer.eventType) return { compatible: false, reason: "EVENT_TYPE_MISMATCH" };
  if (producer.version < consumer.version) return { compatible: false, reason: "CONSUMER_REQUIRES_NEWER_VERSION" };
  const removedRequired = Object.entries(consumer.fields ?? {}).filter(([name, spec]) => spec.required && !producer.fields?.[name]);
  return removedRequired.length ? { compatible: false, reason: "REQUIRED_FIELD_REMOVED", fields: removedRequired.map(([name]) => name) } : { compatible: true };
}