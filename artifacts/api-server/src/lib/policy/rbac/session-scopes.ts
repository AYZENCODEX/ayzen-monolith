/**
 * lib/policy/rbac/session-scopes.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Enforcement Roadmap Track H (Season 2), Phase H14: mints `scopes`/`roles`
 * onto session tokens — the exact gap `packages/authorization`'s
 * `authorizeCapability()` (H9.1) named on day one as the reason its own
 * `CAPABILITY_AUTHZ_GATE` defaults to "report" and not "enforce": *"this
 * gate requires real scopes/roles/stepUpAt claims that nothing in this repo
 * currently mints onto a session token."* This file is what now mints them.
 * `stepUpAt` itself is set at the call site (lib/jwt.ts's `signAuthToken`
 * callers) — a fresh-credential-verification timestamp, not something RBAC
 * data resolves — not here.
 *
 * ── Two vocabularies, one bridge ────────────────────────────────────────
 * RBAC permission keys ("product.resource.action", e.g. "sylo.vault.read"
 * — lib/db/src/schema/rbac.ts) are what an admin actually grants through
 * `role_permissions`. Capability scopes ("domain:action", e.g. "vault:read"
 * — packages/capabilities' `CAPABILITY_REGISTRY.permission` column) are
 * what `packages/authorization`'s `CAPABILITY_POLICIES` require at the
 * gate. The two were never declared to line up 1:1 (RBAC's "sylo"/"ryft"
 * product names are AYZEN's own bot/brand names, not capability domains —
 * see packages/authorization's own header on exactly this point), so
 * `PERMISSION_KEY_TO_SCOPES` below is a deliberate, small, hand-reviewed
 * table — same "editorial call, not derived" posture
 * packages/capabilities/src/index.mjs's `sensitive` column documents for
 * itself — not a mechanical transform of one vocabulary into the other.
 *
 * ── Coverage, honestly stated ───────────────────────────────────────────
 * AK4 Phase 1a (migration 119) closed the original gap this section used
 * to describe: migrations/096 + 119 together now grant `user` (and, via
 * `parent_role_key`, `dev`/`admin`) every non-admin-domain capability in
 * `CAPABILITY_REGISTRY` — the full non-admin-bot command surface
 * (ayzenx/warde/verve/ryft/sylo/skarn/zynth/wisp). All `admin.*`
 * capabilities remain reachable only via `admin`'s seeded global "*"
 * wildcard, matching `requireAdmin`'s existing "admin can do anything"
 * behavior. `scripts/validate-capability-scope-coverage.mjs` is the
 * checked, re-runnable proof of this — run it after touching this table
 * or migrations/096/119's seed data, not just after this comment.
 *
 * ── Fails open on ITS OWN error, never on the login itself ─────────────
 * A DB error resolving roles/permissions must never fail a login — it
 * degrades to a token with `scopes: []`, which `CAPABILITY_AUTHZ_GATE`'s
 * "report" default turns into "logged, not blocked," never into "can't
 * sign in." The one thing this file must not do is make authentication
 * itself depend on RBAC's read path being healthy.
 */

import { CAPABILITY_REGISTRY } from "@ayzen/capabilities";
import { logger } from "../../logger";
import { legacyRoleToRoleKeys } from "./legacy-role-map";
import { resolveEffectivePermissions } from "./role-resolver";
import { DrizzleRbacProvider } from "./drizzle-rbac-provider";
import type { RbacProvider } from "./types";

// Deliberately a SEPARATE instance from middlewares/auth.ts's
// `getPepRbacProvider()` singleton (same reasoning that file's own header
// gives for why lib/policy-admin-console.ts etc. each keep their own:
// `DrizzleRbacProvider` is a stateless wrapper over the shared
// `@workspace/db` client — nothing here to isolate, cheap enough to
// construct once per module rather than reach into another file's private
// singleton). Same underlying tables either way, so both layers always
// see identical grants.
const rbacProvider: RbacProvider = new DrizzleRbacProvider();

/**
 * Every distinct capability scope string `CAPABILITY_REGISTRY` declares,
 * deduped. What RBAC's admin global wildcard ("*") resolves to — matching
 * `requireAdmin`'s / migration 096's existing "admin can do anything"
 * behavior exactly, expressed in the new scope vocabulary rather than
 * narrowing it.
 */
export const ALL_CAPABILITY_SCOPES: readonly string[] = Object.freeze([
  ...new Set(CAPABILITY_REGISTRY.map((entry: { permission?: string }) => entry.permission).filter((value): value is string => Boolean(value))),
]);

/**
 * Concrete RBAC permission key -> capability scope(s) it implies. Every key
 * here must exist in migrations/096_ayzen_rbac_core.sql's seed catalog (or
 * a later migration's) — add the RBAC permission and this mapping
 * together, reviewed as a pair, never one without the other.
 */
const PERMISSION_KEY_TO_SCOPES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "sylo.vault.read": ["vault:read"],
  "sylo.vault.update": ["vault:write"],
  "ryft.payment.create": ["finance:write"],
  "ryft.payment.approve": ["finance:write"],
  // Best-effort, not a precise fit: no "admin:user:*" scope is registered
  // in CAPABILITY_REGISTRY today (admin's registered scopes are
  // admin:read, admin:audit, admin:data:read, admin:data:write,
  // admin:break-glass) — a future admin-user-management capability should
  // get its own scope, at which point this entry should point there
  // instead of borrowing admin:data:write.
  "admin.user.manage": ["admin:data:write"],
  // ── AK4 Phase 1a (migration 119) — one key per scope that was
  // previously reachable only via admin's "*" wildcard. Key names mirror
  // the scope string (":" -> ".") 1:1, so the mapping needs no comment
  // per entry; see migration 119's own header for the full rationale and
  // the scoping decision behind granting these to "user".
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
});

/**
 * Grant patterns whose product prefix (the segment(s) before a trailing
 * "*") should still resolve to every scope this table knows about under
 * that prefix, even though no *concrete* key was granted — e.g. "sylo.*"
 * should reach "vault:read"/"vault:write" via the two sylo.vault.* entries
 * above, not just whichever exact keys happen to be listed.
 */
function scopesForPrefix(prefix: string): string[] {
  const dotted = `${prefix}.`;
  return Object.entries(PERMISSION_KEY_TO_SCOPES)
    .filter(([key]) => key === prefix || key.startsWith(dotted))
    .flatMap(([, scopes]) => [...scopes]);
}

/**
 * Expands a set of resolved RBAC grant patterns (concrete keys,
 * trailing-wildcard patterns, or the bare global "*" —
 * permission-matcher.ts's grammar) into capability scopes. Exported so
 * `scripts/validate-capability-scope-coverage.mjs` can run the identical
 * expansion offline against every seeded role, instead of re-implementing
 * it a second time and risking drift between the check and the real path.
 */
export function expandGrantsToScopes(grants: Iterable<string>): string[] {
  const scopes = new Set<string>();
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
  return [...scopes];
}

export interface SessionScopes {
  /** Capability scopes to embed in the session token's `scopes` claim. */
  scopes: string[];
  /** RBAC role keys (legacy-implicit + explicit `user_roles`) this session
   *  was resolved from — embedded in the token's `roles` claim mainly for
   *  observability (what a `policy.decision.denied` log line can show),
   *  not itself consulted by `authorizeCapability()`, which only checks
   *  `scopes`. */
  roles: string[];
}

const EMPTY_SESSION_SCOPES: SessionScopes = Object.freeze({ scopes: [], roles: [] });

/**
 * Resolves what a freshly-authenticated user's session token should carry:
 * every RBAC role they hold (legacy `users.role` membership plus any
 * explicit `user_roles` grant) and every capability scope those roles'
 * permissions expand to. Mirrors `rbac-rule.ts`'s own "legacy + explicit
 * roles, then `resolveEffectivePermissions()`" pattern exactly, so a
 * token's `scopes` claim and whatever the DB-backed RBAC `PolicyRule`
 * would separately decide for the same user never drift from two
 * differently-written code paths computing the same union twice.
 *
 * Never throws — see file header for why a resolution failure degrades to
 * `{ scopes: [], roles: [] }` rather than failing the login itself.
 */
export async function resolveSessionScopes(userId: number, role: string): Promise<SessionScopes> {
  try {
    const roleKeys = new Set<string>([
      ...legacyRoleToRoleKeys(role),
      ...(await rbacProvider.getUserRoleKeys(userId)),
    ]);
    if (roleKeys.size === 0) return EMPTY_SESSION_SCOPES;
    const grants = await resolveEffectivePermissions(rbacProvider, [...roleKeys]);
    return { scopes: expandGrantsToScopes(grants), roles: [...roleKeys] };
  } catch (error) {
    logger.warn(
      { err: error, userId },
      "[H14] session-scope resolution failed; issuing a token with no scopes — CAPABILITY_AUTHZ_GATE's 'report' default logs this as reduced access, it does not block the login",
    );
    return EMPTY_SESSION_SCOPES;
  }
}
