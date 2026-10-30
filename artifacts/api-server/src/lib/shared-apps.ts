/**
 * The branded AYZEN products intentionally run behind one API deployment.
 * This module is the server-side source of truth for the host-to-app mapping
 * used by redirects, shared API discovery, and SIORA request context.
 *
 * It does not perform authentication or authorization. Those remain owned by
 * the existing auth and Policy Engine middleware.
 */

export type SharedAppId = "sylo" | "ryft" | "fyra" | "verve" | "skarn" | "warde" | "wisp" | "zynth";

export type SharedAppDefinition = {
  id: SharedAppId;
  label: string;
  homePath: string;
  routePrefixes: readonly string[];
  hostEnv: string;
  defaultHost: string;
};

export const SHARED_APP_DEFINITIONS: readonly SharedAppDefinition[] = [
  // Module Shell Split S1: sylo owns /admin/team-vault outright (vault data);
  // it was double-claimed by warde before this pass.
  { id: "sylo", label: "Sylo", homePath: "/vault", routePrefixes: ["/vault", "/admin/vault", "/admin/team-vault"], hostEnv: "SYLO_HOSTS", defaultHost: "sylo.ayzen.tech" },
  // Module Shell Split S1: /finance (including Investments) moved to Fyra.
  { id: "ryft", label: "Ryft", homePath: "/wallet", routePrefixes: ["/wallet", "/wallets", "/admin/tools/wallet"], hostEnv: "RYFT_HOSTS", defaultHost: "ryft.ayzen.tech" },  { id: "fyra", label: "Fyra", homePath: "/finance", routePrefixes: ["/finance"], hostEnv: "FYRA_HOSTS", defaultHost: "fyra.ayzen.tech" },

  { id: "verve", label: "Verve", homePath: "/marketplace/hub", routePrefixes: ["/marketplace", "/admin/marketplace", "/admin/marketplace-categories", "/admin/marketplace-market-config"], hostEnv: "VERVE_HOSTS", defaultHost: "verve.ayzen.tech" },
  { id: "skarn", label: "Skarn", homePath: "/projects", routePrefixes: ["/projects", "/tasks", "/content", "/admin/projects", "/admin/project-templates", "/admin/operator-progress", "/admin/tasks"], hostEnv: "SKARN_HOSTS", defaultHost: "skarn.ayzen.tech" },
  { id: "warde", label: "Warde", homePath: "/teams", routePrefixes: ["/teams", "/team_leader", "/admin/teams", "/admin/team-vault"], hostEnv: "WARDE_HOSTS", defaultHost: "warde.ayzen.tech" },
  { id: "wisp", label: "Wisp", homePath: "/mailbox", routePrefixes: ["/mailbox", "/ayzen-email", "/email-accounts", "/admin/mail-sending-config"], hostEnv: "WISP_HOSTS", defaultHost: "wisp.ayzen.tech" },
  { id: "zynth", label: "Zynth", homePath: "/assistant", routePrefixes: ["/assistant", "/admin/ai-agent"], hostEnv: "ZYNTH_HOSTS", defaultHost: "zynth.ayzen.tech" },
];

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