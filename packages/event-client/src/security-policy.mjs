import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Phase H10.1 — `config/eventbus/security.json` (`defaultDeny`,
 * `producerIdentity`, `consumerIdentity`, `restrictedPayloads`,
 * `sensitiveEventsRequireAudit`) was Season 2 finding #9: the only
 * reference in the whole repo was a script that validates the file's
 * *shape*, never a runtime consumer that enforces it.
 *
 * This mirrors `packages/workflow/src/security-policy.mjs`'s loader
 * exactly (same fail-closed reasoning: a missing/misreadable config file
 * must never silently turn enforcement off, so a read/parse failure falls
 * back to every flag at its documented, strictest default rather than
 * `{}`). `packages/event-client/src/index.mjs` is the only caller.
 * `restrictedPayloads` / `sensitiveEventsRequireAudit` are read here too
 * (for completeness — this is the one place the file is parsed) but stay
 * H10.2's job to actually enforce, not this phase's.
 */
export const DEFAULT_EVENTBUS_SECURITY_POLICY = Object.freeze({
  schemaVersion: 1,
  defaultDeny: true,
  producerIdentity: "service-auth",
  consumerIdentity: "service-auth",
  restrictedPayloads: Object.freeze(["credentials", "tokens", "private-keys"]),
  sensitiveEventsRequireAudit: true,
});

function resolveConfigPath() {
  if (process.env.EVENTBUS_SECURITY_CONFIG_PATH) return process.env.EVENTBUS_SECURITY_CONFIG_PATH;
  // packages/event-client/src/ -> repo root is three levels up. Resolved
  // from this file's own location (not process.cwd()) so it works the
  // same whether the caller's cwd is the repo root (tests, scripts) or a
  // service's own directory (a deployed process).
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../config/eventbus/security.json");
}

let cached;

export function loadEventBusSecurityPolicy({ forceReload = false } = {}) {
  if (cached && !forceReload) return cached;
  const configPath = resolveConfigPath();
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    cached = Object.freeze({ ...DEFAULT_EVENTBUS_SECURITY_POLICY, ...parsed });
  } catch {
    // Fail closed rather than fail open: an unreadable/missing file keeps
    // every enforcement flag at its documented strictest value instead of
    // quietly reopening the Season 2 #9 gap this phase closes.
    cached = DEFAULT_EVENTBUS_SECURITY_POLICY;
  }
  return cached;
}

/** Test-only: clears the module-level cache so a test can point
 * EVENTBUS_SECURITY_CONFIG_PATH at a fixture and see it take effect. */
export function __resetEventBusSecurityPolicyCacheForTests() {
  cached = undefined;
}
