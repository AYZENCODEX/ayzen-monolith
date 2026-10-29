#!/usr/bin/env node
/**
 * scripts/validate-event-wiring.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Enforcement gate for the class of bug this repo has fixed one-by-one
 * across Track H (H7.1's dispatch table, H7.3's search subscription,
 * H7.5's terminal-event subscription, H12.1's identity emittedEvents
 * correction, and this pass's notification.sent/notification.failed fix):
 * a service's `createServiceServer({ emittedEvents, consumedEvents })`
 * declaration is a runtime claim (`GET /internal/manifest` — see
 * packages/service-runtime's `manifest` object) that nothing here ever
 * checked against the actual code. It is easy for a declaration to drift
 * from reality in either direction:
 *
 *   1. EMITTED, NEVER PUBLISHED — an event type is listed in
 *      `emittedEvents` but no `publish(...)`/`publish.publish(...)` call
 *      anywhere in that service's own source ever uses that event type.
 *      (This is exactly what `notification.sent`/`notification.failed`
 *      were before this pass — see docs/audit/ for the write-up.)
 *
 *   2. CONSUMED, NEVER WIRED — an event type is listed in a service's
 *      `consumedEvents` but nothing ever subscribes to it: not the
 *      service itself (the H7.3/H7.5 pattern — a direct
 *      `bus.subscribe(eventType, ...)` in the service's own source), and
 *      not `apps/worker/src/index.mjs`'s dispatch table (the H7.1 pattern
 *      — a `registry.register(eventType, owner, ...)` call, including the
 *      deliberate `acknowledgeOnly(...)` entries documented there for a
 *      consumedEvents entry with no specified business behavior yet).
 *
 * Detection is a source-grep heuristic, not a real static analyzer — it
 * matches the declared event-type string literal appearing on a line that
 * also mentions `publish`/`subscribe`/`registry.register` in the relevant
 * file(s). That is loose enough to false-negative on a genuinely novel
 * wiring shape (flag it, don't fight the grep) but tight enough to catch
 * the actual bug class seen so far: a declaration with *zero* matching
 * lines anywhere in scope.
 *
 * Same baseline convention as Track F's
 * validate-domain-contract-coverage.mjs and Track H's ownership-gate
 * baseline: today's known findings (if any survive after this pass's
 * fixes) are frozen in scripts/event-wiring-baseline.json. This gate
 * fails only on a *new* finding beyond that baseline.
 *
 * Usage:
 *   node scripts/validate-event-wiring.mjs
 *   node scripts/validate-event-wiring.mjs --update-baseline
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SERVICES_DIR = path.join(ROOT, "services");
const WORKER_INDEX = path.join(ROOT, "apps/worker/src/index.mjs");
const BASELINE_FILE = path.join(__dirname, "event-wiring-baseline.json");

function listFiles(dir, { excludeTests = true } = {}) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full, { excludeTests }));
    } else if (/\.mjs$/.test(entry.name) && !(excludeTests && /\.test\.mjs$/.test(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

function readAll(files) {
  return files.map((file) => ({ file, text: fs.readFileSync(file, "utf8") }));
}

function extractServiceManifest(text) {
  // Pulls the arguments passed to createServiceServer({...}) as plain
  // text, then pulls `service:`, `emittedEvents:` and `consumedEvents:`
  // out of that block specifically — avoids false matches from unrelated
  // arrays elsewhere in the same file.
  const callStart = text.indexOf("createServiceServer(");
  if (callStart === -1) return undefined;
  const block = text.slice(callStart, callStart + 4000);
  const serviceMatch = block.match(/service:\s*["'`]([^"'`]+)["'`]/);
  const emittedMatch = block.match(/emittedEvents:\s*\[([^\]]*)\]/);
  const consumedMatch = block.match(/consumedEvents:\s*\[([^\]]*)\]/);
  const parseList = (raw) => (raw ?? "").split(",").map((entry) => entry.trim().replace(/^["'`]|["'`]$/g, "")).filter(Boolean);
  return {
    service: serviceMatch?.[1],
    emittedEvents: parseList(emittedMatch?.[1]),
    consumedEvents: parseList(consumedMatch?.[1]),
  };
}

const CALL_WINDOW = 600; // chars scanned after a call-site keyword for a co-occurring event-type literal

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True if `eventType` (as a quoted string literal) appears within
 * `CALL_WINDOW` characters after some occurrence of `callSite` (e.g.
 * ".publish(" or ".subscribe(") in `text`. Windowed rather than
 * same-line because this repo's publish() calls are routinely
 * multi-line object literals (see services/marketplace/src/index.mjs).
 */
function callSiteNearLiteral(text, callSite, eventType) {
  const literal = new RegExp(`["'\`]${escapeRegExp(eventType)}["'\`]`);
  let from = 0;
  for (;;) {
    const at = text.indexOf(callSite, from);
    if (at === -1) return false;
    const window = text.slice(at, at + CALL_WINDOW);
    if (literal.test(window)) return true;
    from = at + callSite.length;
  }
}

/** True if `eventType` appears anywhere as an object-literal key, e.g. in
 * a `{ "eventType": handler, ... }` dispatch map (the search/workflow
 * H7.3/H7.5 pattern: a generic `bus.subscribe(eventType, ...)` loop over
 * such a map, where the event type itself never appears on the same line
 * as `.subscribe(`). */
function appearsAsHandlerKey(text, eventType) {
  return new RegExp(`["'\`]${escapeRegExp(eventType)}["'\`]\\s*:`).test(text);
}

/** A `.subscribe(someIdentifier, ...)` call — i.e. subscribing to whatever
 * event type a loop variable currently holds, rather than a literal
 * string — the H7.3/H7.5 dynamic-dispatch pattern. */
function hasDynamicSubscribeLoop(text) {
  return /\.subscribe\(\s*[A-Za-z_$][\w$]*\s*,/.test(text);
}

const workerText = fs.existsSync(WORKER_INDEX) ? fs.readFileSync(WORKER_INDEX, "utf8") : "";

function workerRegistersFor(eventType, owner) {
  // registry.register("eventType", "owner", ...) — tolerant of either
  // quote style and incidental whitespace.
  const pattern = new RegExp(
    `registry\\.register\\(\\s*["'\`]${eventType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]\\s*,\\s*["'\`]${owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`,
  );
  return pattern.test(workerText);
}

const findings = [];

for (const dirEntry of fs.existsSync(SERVICES_DIR) ? fs.readdirSync(SERVICES_DIR, { withFileTypes: true }) : []) {
  if (!dirEntry.isDirectory()) continue;
  const serviceDir = path.join(SERVICES_DIR, dirEntry.name);
  const indexFile = path.join(serviceDir, "src", "index.mjs");
  if (!fs.existsSync(indexFile)) continue;
  const indexText = fs.readFileSync(indexFile, "utf8");
  const manifest = extractServiceManifest(indexText);
  if (!manifest?.service) continue;

  const ownScopeFiles = readAll(listFiles(path.join(serviceDir, "src")));
  // Cross-process publishers: apps/worker is the documented, deliberate
  // exception (see apps/worker/src/index.mjs's own H7.5 comment) where an
  // event a service declares as emitted is actually published by the
  // worker on that service's behalf, because the worker is the only
  // process that knows the real outcome (workflow.completed/failed being
  // the current example). Included in the emitted-event scan scope only —
  // never in the consumed-event scope, since "the worker happens to
  // mention this event type in a comment" must not count as that service
  // having subscribed to it.
  const crossProcessPublishers = fs.existsSync(path.dirname(WORKER_INDEX)) ? readAll(listFiles(path.dirname(WORKER_INDEX))) : [];

  for (const eventType of manifest.emittedEvents) {
    const published = [...ownScopeFiles, ...crossProcessPublishers].some(({ text }) => callSiteNearLiteral(text, ".publish(", eventType));
    if (!published) {
      findings.push({ kind: "EMITTED_NEVER_PUBLISHED", service: dirEntry.name, eventType, detail: `emittedEvents declares "${eventType}" but no publish(...) call in services/${dirEntry.name}/src/**/*.mjs (or apps/worker, the one documented cross-process exception) references it` });
    }
  }

  for (const eventType of manifest.consumedEvents) {
    const subscribedLiterally = ownScopeFiles.some(({ text }) => callSiteNearLiteral(text, ".subscribe(", eventType));
    const subscribedDynamically = ownScopeFiles.some(({ text }) => hasDynamicSubscribeLoop(text))
      && ownScopeFiles.some(({ text }) => appearsAsHandlerKey(text, eventType));
    const registeredInWorker = workerRegistersFor(eventType, dirEntry.name);
    if (!subscribedLiterally && !subscribedDynamically && !registeredInWorker) {
      findings.push({ kind: "CONSUMED_NEVER_WIRED", service: dirEntry.name, eventType, detail: `consumedEvents declares "${eventType}" but neither services/${dirEntry.name}/src (direct bus.subscribe) nor apps/worker/src/index.mjs's registry.register("${eventType}", "${dirEntry.name}", ...) wires it` });
    }
  }
}

findings.sort((a, b) => `${a.service}:${a.kind}:${a.eventType}`.localeCompare(`${b.service}:${b.kind}:${b.eventType}`));

if (process.argv.includes("--update-baseline")) {
  fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(findings, null, 2)}\n`);
  console.log(JSON.stringify({ baselineUpdated: true, findings: findings.length }, null, 2));
  process.exit(0);
}

const baseline = fs.existsSync(BASELINE_FILE) ? JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8")) : [];
const baselineKeys = new Set(baseline.map((entry) => `${entry.service}:${entry.kind}:${entry.eventType}`));
const newFindings = findings.filter((entry) => !baselineKeys.has(`${entry.service}:${entry.kind}:${entry.eventType}`));

if (newFindings.length > 0) {
  console.error(`event-wiring: ${newFindings.length} new declared-but-unwired event(s) found (beyond the ${baseline.length}-entry baseline):`);
  for (const finding of newFindings) console.error(`  [${finding.kind}] ${finding.service}: ${finding.detail}`);
  console.error("\nEither wire the event (publish/subscribe/registry.register), correct the declaration, or if this is a deliberately accepted gap run --update-baseline after review.");
  process.exit(1);
}

console.log(JSON.stringify({ status: "passed", totalFindings: findings.length, baselineSize: baseline.length }, null, 2));
