/** Shared helpers for per-module nav configs (pure, type imports only). */
import type { NavGroup } from "../app-sidebar";

export type NavEntry = NavGroup["items"][number];
export type NavLeaf = Extract<NavEntry, { href: string }>;
export type NavSection = Exclude<NavEntry, NavLeaf>;

export const isLeaf = (entry: NavEntry): entry is NavLeaf => typeof (entry as { href?: unknown }).href === "string";
export const isSectionEntry = (entry: NavEntry): entry is NavSection => !isLeaf(entry);

export function leafHrefs(entries: NavEntry[], acc: string[] = []): string[] {
  for (const entry of entries) {
    if (isLeaf(entry)) acc.push(entry.href);
    else if ((entry as { children?: NavEntry[] }).children) leafHrefs((entry as { children: NavEntry[] }).children, acc);
  }
  return acc;
}

/** True when the group is non-empty and EVERY leaf lives under one of `prefixes` (exact, "/x/..." or "/x?..."). */
export function allLeavesUnder(group: NavGroup, prefixes: readonly string[]): boolean {
  const hrefs = leafHrefs(group.items);
  return hrefs.length > 0 && hrefs.every((h) => prefixes.some((p) => h === p || h.startsWith(`${p}/`) || h.startsWith(`${p}?`)));
}

export const labelIs = (group: NavGroup, label: string) => group.label.trim().toLowerCase() === label.toLowerCase();
