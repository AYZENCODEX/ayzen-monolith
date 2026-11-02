import type { NavGroup } from "../app-sidebar";
import { fyraNav } from "./fyra";
import { restructureModuleGroups, type ModuleNavConfig } from "./restructure";
import { skarnNav } from "./skarn";
import { syloNav } from "./sylo";
import { verveNav } from "./verve";
import { wardeNav } from "./warde";
import { wispNav } from "./wisp";
import { zynthNav } from "./zynth";

/**
 * Per-module sidebar layouts. A module without an entry keeps the sidebar it
 * inherits from the central nav (Ryft: a single "Wallet" link, nothing to split
 * yet, so it is intentionally not listed).
 */
export const MODULE_NAV: Readonly<Record<string, ModuleNavConfig>> = {
  sylo: syloNav,
  fyra: fyraNav,
  verve: verveNav,
  skarn: skarnNav,
  warde: wardeNav,
  wisp: wispNav,
  zynth: zynthNav,
};

export function applyModuleNav(moduleId: string, groups: NavGroup[]): NavGroup[] {
  const config = MODULE_NAV[moduleId];
  return config ? restructureModuleGroups(config, groups) : groups;
}
