#!/usr/bin/env node
/**
 * scripts/validate-capability-scope-coverage.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Enforcement Roadmap Track H (Season 2), Phase H14.
 *
 * `packages/authorization`'s `CAPABILITY_AUTHZ_GATE` (H9.1/H9.2) has
 * defaulted to "report" (log-only, never blocks) since it was written,
 * because — per that code's own comment — nothing minted real
 * `scopes`/`roles`/`stepUpAt` claims onto a session token. Phase H14
 * (`lib/policy/rbac/session-scopes.ts`) closes THAT gap. It does not, by
 * itself, answer the second question the rollout the H9.2 comment
 * describes actually needs before flipping the gate: *given what RBAC
 * currently grants, would flipping `CAPABILITY_AUTHZ_GATE` to "enforce"
 * deny requests a real, legitimately-privileged user is supposed to be
 * able to make?*
 *
 * This script answers that question the only way available without a
 * live deployment to dry-run against real traffic: it re-runs the EXACT
 * same expansion `lib/policy/rbac/session-scopes.ts` uses (mirrored here,
 * not imported — this repo's scripts are plain .mjs, that file is
 * TypeScript; see the self-check below for how the mirror is kept honest)
 * over every role migration 096 actually seeds today, and reports, for
 * every SENSITIVE or SCOPED capability in `CAPABILITY_REGISTRY`, whether
 * that role would satisfy it.
 *
 * This is intentionally NOT wired as a pass/fail CI gate the way
 * validate-event-wiring.mjs is — a coverage gap here is not a bug to fix
 * by editing code, it is a genuine "RBAC hasn't granted this yet"
 * product fact, exactly the kind of finding the wiring audit's own §5
 * said needs a scoping decision, not a patch. Run it manually (or from
 * `full-system-audit.mjs`, informational) whenever someone is deciding
 * whether it's safe to flip CAPABILITY_AUTHZ_GATE.
 *
 * Usage:
 *   node scripts/validate-capability-scope-coverage.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITY_REGISTRY } from "../packages/capabilities/src/index.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SESSION_SCOPES_FILE = path.join(ROOT, "artifacts/api-server/src/lib/policy/rbac/session-scopes.ts");
// 096 seeds the roles/base grants; 119 (AK4 Phase 1a) is the first
// follow-on migration that adds more role_permissions rows via the same
// CROSS JOIN/SELECT-literal shapes. Add future grant-expanding migrations
// here in file order — parseSeededRoleGraph() concatenates them before
// parsing, so a role's grants accumulate across files exactly as they
// would in a real, migrated database.
const RBAC_MIGRATION_FILES = [
  path.join(ROOT, "migrations/096_ayzen_rbac_core.sql"),
  path.join(ROOT, "migrations/119_ak4_phase1a_rbac_capability_coverage.sql"),
];

// ── Mirror of lib/policy/rbac/session-scopes.ts's PERMISSION_KEY_TO_SCOPES ──
// Deliberately duplicated, not imported (this script is plain .mjs; that
// file is TypeScript) — same "two independent shallow checks, kept honest
// by a self-check rather than a shared import" posture
// lib/db/src/schema/rbac.ts's own header already documents for its own
// duplicated grant-pattern validator. The self-check below fails loudly
// if this mirror and the real table drift, instead of silently trusting
// a stale copy.
const PERMISSION_KEY_TO_SCOPES = {
  "sylo.vault.read": ["vault:read"],
  "sylo.vault.update": ["vault:write"],
  "ryft.payment.create": ["finance:write"],
  "ryft.payment.approve": ["finance:write"],
  "admin.user.manage": ["admin:data:write"],
  // AK4 Phase 1a (migration 119) — must match session-scopes.ts's own
  // mirror 1:1, or this self-check fails loudly (see checkMirrorIsInSync).
  "identity.authenticate": ["identity:authenticate"],
  "identity.session.write": ["identity:session:write"],
  "workspace.read": ["workspace:read"],
  "workspace.membership.write": ["workspace:membership:write"],
  "finance.read": ["finance:read"],
  "mail.read": ["mail:read"],
  "mail.send": ["mail:send"],
  "notification.write": ["notification:write"],
  "notification.read": ["notification:read"],
  "workflow.write": ["workflow:write"],
  "workflow.read": ["workflow:read"],
  "ai.execute": ["ai:execute"],
  "search.read": ["search:read"],
  "verve.read": ["verve:read"],
  "verve.write": ["verve:write"],
  "warde.read": ["warde:read"],
  "warde.write": ["warde:write"],
};

function scopesForPrefix(prefix) {
  const dotted = `${prefix}.`;
  return Object.entries(PERMISSION_KEY_TO_SCOPES)
    .filter(([key]) => key === prefix || key.startsWith(dotted))
    .flatMap(([, scopes]) => scopes);
}

const ALL_CAPABILITY_SCOPES = [...new Set(CAPABILITY_REGISTRY.map((entry) => entry.permission).filter(Boolean))];

function expandGrantsToScopes(grants) {
  const scopes = new Set();
  for (const grant of grants) {
    if (grant === "*") {
      for (const scope of ALL_CAPABILITY_SCOPES) scopes.add(scope);
      continue;
    }
    if (grant.endsWith(".*")) {
      for (const scope of scopesForPrefix(grant.slice(0, -2))) scopes.add(scope);
      continue;
    }
    for (const scope of PERMISSION_KEY_TO_SCOPES[grant] ?? []) scopes.add(scope);
  }
  return scopes;
}

// ── Self-check: this script's PERMISSION_KEY_TO_SCOPES mirror vs. the
// real one ───────────────────────────────────────────────────────────────
function checkMirrorIsInSync() {
  const source = fs.readFileSync(SESSION_SCOPES_FILE, "utf8");
  const drifted = Object.keys(PERMISSION_KEY_TO_SCOPES).filter((key) => !source.includes(`"${key}"`));
  if (drifted.length > 0) {
    console.error(
      `validate-capability-scope-coverage: this script's PERMISSION_KEY_TO_SCOPES mirror has drifted from ${path.relative(ROOT, SESSION_SCOPES_FILE)} — missing key(s) there: ${drifted.join(", ")}. Update one or the other before trusting this report.`,
    );
    process.exitCode = 1;
    return false;
  }
  return true;
}

// ── Seeded role graph, read from migration 096 itself (not hand-copied) ──
// Parses exactly the two INSERT shapes that migration actually uses:
//   - roles(key, ..., parent_role_key, ...) VALUES (...), (...), (...)
//   - role_permissions via "CROSS JOIN (VALUES ('a'), ('b')) ... WHERE r.key = 'X'"
//     and via "SELECT r.id, 'literal' FROM roles r WHERE r.key = 'X'"
// A future migration that seeds roles/grants differently will make this
// parser find nothing for that role — reported as "0 grants", not
// silently assumed empty, so a real gap here is visible rather than
// mistaken for "role has no permissions."
function parseSeededRoleGraph() {
  const sql = RBAC_MIGRATION_FILES.map((file) => fs.readFileSync(file, "utf8")).join("\n");

  const parents = {};
  const roleValuesBlock = sql.match(/INSERT INTO roles[\s\S]*?VALUES([\s\S]*?);/);
  if (roleValuesBlock) {
    // Descriptions contain SQL-escaped '' apostrophes (e.g. "...role = ''user''
    // default."), which makes matching the whole row shape in one regex
    // fragile — this only anchors the KEY at the row's start and
    // parent/is_system at its end, never touching the description in
    // between. Each `('...', ..., NULL|'x', TRUE|FALSE)` row is captured by
    // its outer parens (no nested parens appear in this migration's seed
    // data); a row whose leading field isn't a quoted key (e.g. the
    // trailing "ON CONFLICT (key) DO NOTHING" also parenthesizes "key") is
    // simply skipped rather than mis-parsed.
    for (const rowMatch of roleValuesBlock[1].matchAll(/\(([^()]*)\)/g)) {
      const content = rowMatch[1];
      const keyMatch = content.match(/^\s*'([a-z0-9_-]+)'/);
      const tailMatch = content.match(/,\s*(NULL|'([a-z0-9_-]+)')\s*,\s*(TRUE|FALSE)\s*$/);
      if (!keyMatch || !tailMatch) continue;
      parents[keyMatch[1]] = tailMatch[2] ?? null;
    }
  }

  const grants = {};
  const addGrant = (roleKey, permissionKey) => {
    (grants[roleKey] ??= new Set()).add(permissionKey);
  };

  // "CROSS JOIN (VALUES ('a'), ('b'), ...) AS p(permission_key) ... WHERE r.key = 'X'"
  const crossJoinRe = /CROSS JOIN \(VALUES ([\s\S]*?)\) AS p\(permission_key\)\s*\nWHERE r\.key = '([a-z0-9_-]+)'/g;
  let cj;
  while ((cj = crossJoinRe.exec(sql))) {
    const [, valuesList, roleKey] = cj;
    for (const literal of valuesList.matchAll(/'([^']+)'/g)) addGrant(roleKey, literal[1]);
  }

  // "SELECT r.id, 'literal' FROM roles r WHERE r.key = 'X'"
  const selectLiteralRe = /SELECT r\.id, '([^']+)'\s*\nFROM roles r\s*\nWHERE r\.key = '([a-z0-9_-]+)'/g;
  let sl;
  while ((sl = selectLiteralRe.exec(sql))) {
    const [, permissionKey, roleKey] = sl;
    addGrant(roleKey, permissionKey);
  }

  return { parents, grants };
}

function effectiveGrantsFor(roleKey, { parents, grants }, seen = new Set()) {
  if (seen.has(roleKey)) return new Set(); // cycle guard, mirrors role-resolver.ts
  seen.add(roleKey);
  const own = grants[roleKey] ?? new Set();
  const parentKey = parents[roleKey];
  const inherited = parentKey ? effectiveGrantsFor(parentKey, { parents, grants }, seen) : new Set();
  return new Set([...own, ...inherited]);
}

function main() {
  const mirrorOk = checkMirrorIsInSync();
  const { parents, grants } = parseSeededRoleGraph();
  const roleKeys = Object.keys(parents);
  if (roleKeys.length === 0) {
    console.error(`validate-capability-scope-coverage: could not parse any seeded roles out of ${RBAC_MIGRATION_FILES.map((file) => path.relative(ROOT, file)).join(", ")} — migration format may have changed; update this script's parser.`);
    process.exit(1);
  }

  const scopedCapabilities = CAPABILITY_REGISTRY.filter((entry) => (entry.permission && entry.permission.length > 0) || entry.sensitive);

  console.log(`Seeded roles: ${roleKeys.join(", ")}`);
  console.log(`Scoped/sensitive capabilities checked: ${scopedCapabilities.length} of ${CAPABILITY_REGISTRY.length} total\n`);

  // AK4 Phase 1a's own scoping decision: "admin" domain capabilities are
  // intended to stay reachable ONLY via admin's seeded "*" wildcard — a
  // non-admin role never covering them is the intended shape, not a gap.
  // Every other domain is intended to be fully covered by "user" (and
  // inherited by "dev"/"admin"). Reported separately so the conclusion
  // below reflects what the team actually intends to support, per this
  // script's own "done when" bar, instead of treating "admin.* isn't
  // granted to user" as an unresolved finding forever.
  const isIntentionallyAdminOnly = (capability) => CAPABILITY_REGISTRY.find((entry) => entry.capability === capability)?.domain === "admin";

  let anyUnintendedGap = false;
  for (const roleKey of roleKeys) {
    const roleGrants = effectiveGrantsFor(roleKey, { parents, grants });
    const roleScopes = expandGrantsToScopes(roleGrants);
    const covered = [];
    const uncovered = [];
    for (const capability of scopedCapabilities) {
      const required = capability.permission ? [capability.permission] : [];
      const ok = required.every((scope) => roleScopes.has(scope));
      (ok ? covered : uncovered).push(capability.capability);
    }
    const unintendedGaps = uncovered.filter((capability) => !isIntentionallyAdminOnly(capability) || roleKey === "admin");
    const intendedAdminOnlyGaps = uncovered.filter((capability) => isIntentionallyAdminOnly(capability) && roleKey !== "admin");
    console.log(`── role "${roleKey}" ──`);
    console.log(`  RBAC grants (own + inherited): ${roleGrants.size ? [...roleGrants].join(", ") : "(none)"}`);
    console.log(`  Resolves to capability scopes: ${roleScopes.size ? [...roleScopes].join(", ") : "(none)"}`);
    console.log(`  Covered capabilities:   ${covered.length}/${scopedCapabilities.length}`);
    if (intendedAdminOnlyGaps.length > 0) {
      console.log(`  NOT covered, BY DESIGN (admin-domain, admin-only): ${intendedAdminOnlyGaps.join(", ")}`);
    }
    if (unintendedGaps.length > 0) {
      anyUnintendedGap = true;
      console.log(`  NOT covered, UNINTENDED (would get MISSING_SCOPE if the gate enforced today): ${unintendedGaps.join(", ")}`);
    }
    console.log("");
  }

  if (anyUnintendedGap) {
    console.log(
      "CONCLUSION: at least one seeded role would fail MISSING_SCOPE on at least one capability\n" +
      "it is supposed to reach, under today's RBAC grants. Flipping CAPABILITY_AUTHZ_GATE to\n" +
      "\"enforce\" now would deny real, legitimately-privileged requests, not just bad ones —\n" +
      "matching (and now backed by data instead of just the code comment) the exact reason H9.2\n" +
      "defaulted this gate to \"report\". Do not flip the default without first expanding\n" +
      "role_permissions seed data (or a real grant UI, once one exists) to cover the capabilities\n" +
      "listed above as UNINTENDED gaps, then re-running this script until every role you intend to\n" +
      "support shows zero unintended gaps for the routes it should reach.",
    );
  } else {
    console.log("CONCLUSION: every seeded role covers every scoped/sensitive capability it is intended to reach (admin-domain capabilities remain intentionally admin-only). No data-driven objection to flipping CAPABILITY_AUTHZ_GATE found here — still confirm via a real \"report\" mode observation window before flipping, per H9.2's own rollout note.");
  }

  // Never fails CI by itself (see file header) — but a parser/self-check
  // failure above already set process.exitCode = 1, and is preserved here.
  if (!mirrorOk) process.exit(1);
}

main();
