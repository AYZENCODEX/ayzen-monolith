/**
 * lib/oidc-rollout-scope.ts — W1-P4: which app ids may have their OIDC rollout flag flipped WITHOUT the explicit override.
 *
 * Season 3 only allowed `sylo` (its client wiring was the only one built). W1-P4 wires "Login with AYZEN" for every module
 * (client side: lib/module-oidc-login.ts; server side: POST /auth/module/oidc), so each module's own client id may now be
 * toggled per module — that IS the per-module rollout flag. Anything else (a third-party dynamically registered client, a typo)
 * still needs the override, exactly as before.
 *
 * The legacy credential cutover (lib/oidc-cutover-gate.ts) is a SEPARATE, deliberately still Sylo-only decision: turning a
 * module's flag on shows "Continue with AYZEN" there; it does not (yet) block that module's other login paths.
 */
import { MODULES } from "@ayzen/module-registry";

export const ROLLOUT_ALLOWED_WITHOUT_OVERRIDE: ReadonlySet<string> = new Set(MODULES.map((m) => m.oidcClientId));
