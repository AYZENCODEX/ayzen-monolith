/**
 * lib/build-module.ts — W2-P2: which module THIS bundle was built for.
 *
 * `VITE_MODULE=<id>` is set by vite.module.config.ts (one build per module, see build/module-pages.mjs). Without it (the
 * central/full build, tests, dev) every function here behaves as "no restriction", so nothing changes for existing builds.
 * In a module build, other modules' page code is not even in the bundle (the build replaces those pages with an empty stub);
 * this file makes the router agree, so such a URL is the ordinary not-found page instead of a blank stub.
 */
import { getModuleIdForPath, getModule, type ModuleId } from "@ayzen/module-registry";

function readEnv(): string | undefined {
  try { return (import.meta as any).env?.VITE_MODULE as string | undefined; } catch { return undefined; }
}

/** The module this bundle is for, or null for the central/full build. An unknown value is ignored (the build config rejects it). */
export function buildModuleId(raw: string | undefined = readEnv()): ModuleId | null {
  const id = raw?.trim().toLowerCase();
  return id && getModule(id) ? (id as ModuleId) : null;
}

/** True when a route path belongs in this build: everything in the full build; in a module build, its own paths and unowned ones. */
export function isRouteInBuild(path: string, build: ModuleId | null = buildModuleId()): boolean {
  if (!build) return true;
  const owner = getModuleIdForPath(path);
  return owner === null || owner === build;
}
