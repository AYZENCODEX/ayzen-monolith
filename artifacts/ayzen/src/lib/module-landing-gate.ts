/**
 * lib/module-landing-gate.ts — W2-P4: decide whether the standalone public landing is shown instead of the app.
 * Pure (inputs passed in) so it is unit-tested. The landing is shown only on a module build, at "/", while signed out.
 * In that case main.tsx renders the landing WITHOUT mounting <App/>, so no provider, hook or analytics runs and no
 * request is made before login ("no auth call before login").
 */
import type { ModuleId } from "@ayzen/module-registry";

export function hasStoredToken(storage: Pick<Storage, "getItem">[] = safeStores()): boolean {
  return storage.some((s) => { try { return !!s.getItem("ayzen_token"); } catch { return false; } });
}
function safeStores(): Pick<Storage, "getItem">[] {
  const out: Pick<Storage, "getItem">[] = [];
  try { out.push(window.localStorage); } catch { /* blocked */ }
  try { out.push(window.sessionStorage); } catch { /* blocked */ }
  return out;
}

export function shouldShowModuleLanding(input: { build: ModuleId | null; pathname: string; hasToken: boolean; enabled?: boolean }): boolean {
  if (input.enabled === false) return false;
  if (!input.build) return false;
  const p = input.pathname.replace(/\/+$/, "");
  return p === "" && !input.hasToken;
}
