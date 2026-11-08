import { LayoutDashboard } from "lucide-react";
import type { NavGroup } from "../app-sidebar";
import type { ModuleNavConfig } from "./restructure";
import { SYLO_HOME } from "../../../lib/sylo-routes";

const leafHrefs = (entries: NavGroup["items"], acc: string[] = []): string[] => {
  for (const entry of entries) {
    if ("children" in entry && entry.children) leafHrefs(entry.children, acc);
    else if ("href" in entry) acc.push(entry.href);
  }
  return acc;
};

/**
 * Sylo (vault): the central "Vault" group is dissolved into Account, Access,
 * Enroll and Other as top-level sections. "Enrollment" is renamed "Enroll".
 * A wrapper is a group labelled/linked as Vault whose every leaf is a USER
 * vault route; admin groups (/admin/vault, /admin/team-vault) are left alone.
 */
export const syloNav: ModuleNavConfig = {
  isWrapper: (group) => {
    const named = group.label.trim().toLowerCase() === "vault" || group.href === "/vault/hub" || group.href === SYLO_HOME;
    if (!named) return false;
    const hrefs = leafHrefs(group.items);
    return hrefs.length > 0 && hrefs.every((h) => h === "/vault" || h.startsWith("/vault/") || h.startsWith("/vault?"));
  },
  order: ["Account", "Access", "Enroll", "Other"],
  rename: { Enrollment: "Enroll" },
  fallbackSection: "Other",
  // The wrapper's header used to link to the Vault Hub; the Console is its replacement.
  pinned: { label: "Home", icon: LayoutDashboard, items: [{ href: SYLO_HOME, label: "Console", icon: LayoutDashboard }] },
};
