/**
 * The branded AYZEN products intentionally run behind one API deployment.
 * This module is the server-side source of truth for the host-to-app mapping
 * used by redirects, shared API discovery, and SIORA request context.
 *
 * It does not perform authentication or authorization. Those remain owned by
 * the existing auth and Policy Engine middleware.
 */

import { MODULES, type ModuleId } from "@ayzen/module-registry";

export type SharedAppId = ModuleId;

export type SharedAppDefinition = {
  id: SharedAppId;
  label: string;
  homePath: string;
  routePrefixes: readonly string[];
  hostEnv: string;
  defaultHost: string;
};

// W0-P3: derived from @ayzen/module-registry (single source of truth). Edit modules there.
export const SHARED_APP_DEFINITIONS: readonly SharedAppDefinition[] = MODULES.map(
  ({ id, label, homePath, routePrefixes, hostEnv, defaultHost }) => ({ id, label, homePath, routePrefixes, hostEnv, defaultHost }),
);

function configuredHosts(definition: SharedAppDefinition): string[] {
  return (process.env[definition.hostEnv] ?? definition.defaultHost)
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

const hostToApp = new Map<string, SharedAppDefinition>(
  SHARED_APP_DEFINITIONS.flatMap((definition) =>
    configuredHosts(definition).map((host) => [host, definition] as const),
  ),
);

export function getSharedAppForHost(hostname: string | undefined): SharedAppDefinition | null {
  if (!hostname) return null;
  return hostToApp.get(hostname.trim().toLowerCase().split(":")[0]) ?? null;
}

export function getSharedAppHosts(definition: SharedAppDefinition): string[] {
  return configuredHosts(definition);
}

export function getSharedAppCatalog(): Array<Omit<SharedAppDefinition, "hostEnv" | "defaultHost"> & { hosts: string[] }> {
  return SHARED_APP_DEFINITIONS.map(({ hostEnv: _hostEnv, defaultHost: _defaultHost, ...definition }) => ({
    ...definition,
    routePrefixes: [...definition.routePrefixes],
    hosts: getSharedAppHosts(SHARED_APP_DEFINITIONS.find((item) => item.id === definition.id)!),
  }));
}