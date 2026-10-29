import crypto from "node:crypto";

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "COMPENSATED", "DEAD_LETTER"]);

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

export function createInMemoryWorkflowStore() {
  const runs = new Map();
  const checkpoints = new Map();
  const steps = new Map();
  const leases = new Map();

  return {
    async acquireLease(runId, owner, ttlMs) {
      const lease = leases.get(runId);
      if (lease && lease.owner !== owner && lease.expiresAt > Date.now()) return false;
      leases.set(runId, { owner, expiresAt: Date.now() + ttlMs });
      return true;
    },
    async renewLease(runId, owner, ttlMs) {
      const lease = leases.get(runId);
      if (!lease || lease.owner !== owner) return false;
      lease.expiresAt = Date.now() + ttlMs;
      return true;
    },
    async releaseLease(runId, owner) {
      if (leases.get(runId)?.owner === owner) leases.delete(runId);
    },
    async createWorkflowInstance(input) {
      const id = input.id ?? crypto.randomUUID();
      const run = {
        id,
        definitionId: input.definitionId,
        definitionVersion: input.definitionVersion ?? 1,
        status: "PENDING",
        currentStepId: null,
        context: clone(input.context ?? {}),
        variables: {},
        lastError: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      runs.set(id, run);
      steps.set(id, new Map());
      return clone(run);
    },
    async loadWorkflowInstance(id) {
      const run = runs.get(id);
      return run ? clone(run) : undefined;
    },
    async updateWorkflowInstance(id, patch) {
      const run = runs.get(id);
      if (!run) throw new Error(`Workflow instance not found: ${id}`);
      Object.assign(run, clone(patch), { updatedAt: new Date().toISOString() });
      return clone(run);
    },
    async saveCheckpoint(runId, state) {
      const entry = { id: crypto.randomUUID(), runId, ...clone(state), createdAt: new Date().toISOString() };
      const list = checkpoints.get(runId) ?? [];
      list.push(entry);
      checkpoints.set(runId, list);
      return clone(entry);
    },
    async loadLatestCheckpoint(runId) {
      const list = checkpoints.get(runId) ?? [];
      return clone(list.at(-1));
    },
    async saveStep(runId, step) {
      const runSteps = steps.get(runId) ?? new Map();
      const key = `${step.stepId}:${step.attempt}`;
      if (!runSteps.has(key)) runSteps.set(key, { ...clone(step), runId });
      else runSteps.set(key, { ...runSteps.get(key), ...clone(step) });
      steps.set(runId, runSteps);
      return clone(runSteps.get(key));
    },
    async listSteps(runId) {
      return [...(steps.get(runId)?.values() ?? [])].map(clone);
    },
    async cancelWorkflowInstance(id, reason = "Cancelled by operator") {
      return this.updateWorkflowInstance(id, { status: "CANCELLED", lastError: reason, completedAt: new Date().toISOString() });
    },
    async isTerminal(id) {
      return TERMINAL.has((await this.loadWorkflowInstance(id))?.status);
    },
    // Phase H11.2 — stalled-run detection (see ../stall-monitor.mjs) needs
    // to poll every run that could still be stalled, i.e. everything not
    // already in a TERMINAL status; this is that enumeration. `updatedAt`
    // is included directly rather than making the monitor re-derive it,
    // since `updateWorkflowInstance`/`saveCheckpoint` are the only two
    // writers that ever move it and both already stamp it on every real
    // step transition (see executor.mjs).
    async listActiveInstances() {
      return [...runs.values()].filter((run) => !TERMINAL.has(run.status)).map(clone);
    },
  };
}

/**
 * Adapter for the existing Postgres schema. The caller supplies a query
 * function with the familiar pg shape: query(text, params) -> { rows }.
 * Keeping the adapter dependency-free lets extracted services choose their
 * existing pool without pulling database ownership into the workflow package.
 */
export function createPostgresWorkflowStore({ query }) {
  if (typeof query !== "function") throw new Error("A Postgres query function is required");
  const read = async (text, params = []) => (await query(text, params)).rows ?? [];
  // The executor works with camelCase runs; the table is snake_case. Keep the
  // raw columns too so existing callers reading e.g. `definition_id` still work.
  const toRun = (row) => row && ({
    ...row,
    definitionId: row.definition_id,
    definitionVersion: row.definition_version,
    currentStepId: row.current_step_id,
    lastError: row.last_error,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
  });
  return {
    async createWorkflowInstance(input) {
      const id = input.id ?? crypto.randomUUID();
      const rows = await read(
        `INSERT INTO workflow_run (id, definition_id, definition_version, status, context, correlation_id, causation_id, max_runtime_ms)
         VALUES ($1,$2,$3,'PENDING',$4::jsonb,$5,$6,$7)
         ON CONFLICT (id) DO NOTHING RETURNING *`,
        [id, input.definitionId, input.definitionVersion ?? 1, JSON.stringify(input.context ?? {}), input.correlationId ?? null, input.causationId ?? null, input.maxRuntimeMs ?? null],
      );
      return toRun(rows[0] ?? (await read("SELECT * FROM workflow_run WHERE id = $1", [id]))[0]);
    },
    async loadWorkflowInstance(id) {
      return toRun((await read("SELECT * FROM workflow_run WHERE id = $1", [id]))[0]);
    },
    // Lease = execution_owner + execution_lease_until (migration 117). The
    // single conditional UPDATE is the lock: only one caller can match the WHERE.
    async acquireLease(runId, owner, ttlMs) {
      const rows = await read(
        `UPDATE workflow_run
            SET execution_owner = $2,
                execution_lease_until = now() + make_interval(secs => $3::double precision / 1000),
                execution_version = execution_version + 1
          WHERE id = $1
            AND (execution_owner IS NULL OR execution_owner = $2 OR execution_lease_until IS NULL OR execution_lease_until < now())
        RETURNING id`,
        [runId, owner, ttlMs],
      );
      return rows.length > 0;
    },
    async renewLease(runId, owner, ttlMs) {
      const rows = await read(
        `UPDATE workflow_run
            SET execution_lease_until = now() + make_interval(secs => $3::double precision / 1000)
          WHERE id = $1 AND execution_owner = $2 AND execution_lease_until >= now()
        RETURNING id`,
        [runId, owner, ttlMs],
      );
      return rows.length > 0;
    },
    async releaseLease(runId, owner) {
      await read("UPDATE workflow_run SET execution_owner = NULL, execution_lease_until = NULL WHERE id = $1 AND execution_owner = $2", [runId, owner]);
    },
    async updateWorkflowInstance(id, patch) {
      const fields = Object.entries(patch);
      if (!fields.length) return this.loadWorkflowInstance(id);
      const columns = fields.map(([key], index) => `${key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)} = $${index + 2}`);
      const values = fields.map(([, value]) => value && typeof value === "object" ? JSON.stringify(value) : value);
      const rows = await read(`UPDATE workflow_run SET ${columns.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`, [id, ...values]);
      return toRun(rows[0]);
    },
    async saveCheckpoint(runId, state) {
      const rows = await read("INSERT INTO workflow_checkpoint (run_id, step_id, state) VALUES ($1,$2,$3::jsonb) RETURNING *", [runId, state.stepId ?? null, JSON.stringify(state)]);
      return rows[0];
    },
    async loadLatestCheckpoint(runId) {
      return (await read("SELECT * FROM workflow_checkpoint WHERE run_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [runId]))[0];
    },
    async saveStep(runId, step) {
      const rows = await read(
        `INSERT INTO workflow_step_run (run_id, step_id, attempt, status, input, output, error, idempotency_key, started_at, finished_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10)
         ON CONFLICT (run_id, step_id, attempt) DO UPDATE SET status=EXCLUDED.status, output=EXCLUDED.output, error=EXCLUDED.error, finished_at=EXCLUDED.finished_at
         RETURNING *`,
        [runId, step.stepId, step.attempt ?? 1, step.status, JSON.stringify(step.input ?? null), JSON.stringify(step.output ?? null), step.error ?? null, step.idempotencyKey ?? `${runId}:${step.stepId}:${step.attempt ?? 1}`, step.startedAt ?? null, step.finishedAt ?? null],
      );
      return rows[0];
    },
    async listSteps(runId) {
      return read("SELECT * FROM workflow_step_run WHERE run_id = $1 ORDER BY id", [runId]);
    },
    async cancelWorkflowInstance(id, reason = "Cancelled by operator") {
      return this.updateWorkflowInstance(id, { status: "CANCELLED", lastError: reason, completedAt: new Date() });
    },
    async isTerminal(id) {
      return TERMINAL.has((await this.loadWorkflowInstance(id))?.status);
    },
    // Phase H11.2 — see the in-memory store's own comment above; same
    // enumeration, backed by the actual table instead of the in-process
    // Map. `updated_at` is what every `updateWorkflowInstance` UPDATE
    // above already stamps via `updated_at = now()`, so it's already the
    // right "last real progress" column with no schema change needed.
    async listActiveInstances() {
      const rows = await read(
        `SELECT * FROM workflow_run WHERE status NOT IN (${[...TERMINAL].map((_, index) => `$${index + 1}`).join(", ")})`,
        [...TERMINAL],
      );
      return rows.map(toRun);
    },
  };
}