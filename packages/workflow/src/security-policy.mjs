import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Phase H8.3 — `config/workflow/security.json` (`defaultDeny`,
 * `workflowOwnerRequired`, `stepAuthorizationRequired`,
 * `approvalForSensitiveSteps`, `cancellationIsAudited`) was Season 2
 * finding #9: the file is validated for *shape* by a script, but nothing
 * at runtime ever reads it, so every one of those flags was fiction.
 *
 * This is the one place that changes: it loads the real file (falling
 * back, fail-closed, to every flag at its documented `true` if the file
 * can't be read — a missing/misreadable config file must never silently
 * turn enforcement off). `packages/workflow/src/executor.mjs` is the only
 * caller; `workflowOwnerRequired` / `cancellationIsAudited` are read here
 * too (for completeness — this is the one place the file is parsed) but
 * are H8.4's job to actually enforce, not this phase's.
 */
export const DEFAULT_WORKFLOW_SECURITY_POLICY = Object.freeze({
  schemaVersion: 1,
  defaultDeny: true,
  workflowOwnerRequired: true,
  stepAuthorizationRequired: true,
  approvalForSensitiveSteps: true,
  cancellationIsAudited: true,
});

function resolveConfigPath() {
  if (process.env.WORKFLOW_SECURITY_CONFIG_PATH) return process.env.WORKFLOW_SECURITY_CONFIG_PATH;
  // packages/workflow/src/ -> repo root is three levels up. Resolved from
  // this file's own location (not process.cwd()) so it works the same
  // whether the caller's cwd is the repo root (tests, scripts) or a
  // service's own directory (a deployed process).
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../config/workflow/security.json");
}

let cached;

export function loadWorkflowSecurityPolicy({ forceReload = false } = {}) {
  if (cached && !forceReload) return cached;
  const configPath = resolveConfigPath();
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    cached = Object.freeze({ ...DEFAULT_WORKFLOW_SECURITY_POLICY, ...parsed });
  } catch {
    // Fail closed rather than fail open: an unreadable/missing file keeps
    // every enforcement flag at its documented `true` instead of quietly
    // reopening the Season 2 #9 gap this phase closes.
    cached = DEFAULT_WORKFLOW_SECURITY_POLICY;
  }
  return cached;
}

/** Test-only: clears the module-level cache so a test can point
 * WORKFLOW_SECURITY_CONFIG_PATH at a fixture and see it take effect. */
export function __resetWorkflowSecurityPolicyCacheForTests() {
  cached = undefined;
}
