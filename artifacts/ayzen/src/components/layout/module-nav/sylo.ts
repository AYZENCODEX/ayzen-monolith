import { LayoutDashboard } from "lucide-react";
import type { NavGroup } from "../app-sidebar";
import type { ModuleNavConfig } from "./restructure";

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
    const named = group.label.trim().toLowerCase() === "vault" || group.href === "/vault/hub";
    if (!named) return false;
    const hrefs = leafHrefs(group.items);
    return hrefs.length > 0 && hrefs.every((h) => h === "/vault" || h.startsWith("/vault/") || h.startsWith("/vault?"));
  },
  order: ["Account", "Access", "Enroll", "Other"],
  rename: { Enrollment: "Enroll" },
  fallbackSection: "Other",
  // The wrapper's header used to link to the vault hub; keep that reachable.
  pinned: { label: "Hub", icon: LayoutDashboard, items: [{ href: "/vault/hub", label: "Vault Hub", icon: LayoutDashboard }] },
};
