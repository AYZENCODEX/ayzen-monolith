import type { NavGroup } from "../app-sidebar";
import { allLeavesUnder, isLeaf, labelIs, type NavEntry, type NavLeaf } from "./helpers";
import type { ModuleNavConfig } from "./restructure";

const under = (href: string, base: string) => href === base || href.startsWith(`${base}/`) || href.startsWith(`${base}?`);

/**
 * Pulls every leaf matching `pred` out of `entries`, however deeply nested.
 * A section left with no children is dropped. In the central nav the "Task"
 * link is the last child INSIDE the Category section, so a plain top-level
 * filter would never find it.
 */
function takeLeaves(entries: NavEntry[], pred: (leaf: NavLeaf) => boolean): { rest: NavEntry[]; taken: NavLeaf[] } {
  const rest: NavEntry[] = [];
  const taken: NavLeaf[] = [];
  for (const entry of entries) {
    if (isLeaf(entry)) {
      if (pred(entry)) taken.push(entry); else rest.push(entry);
      continue;
    }
    const children = (entry as { children?: NavEntry[] }).children ?? [];
    const inner = takeLeaves(children, pred);
    taken.push(...inner.taken);
    if (inner.rest.length > 0) rest.push({ ...entry, children: inner.rest } as NavEntry);
  }
  return { rest, taken };
}

const group = (label: string, items: NavEntry[], icon: NavGroup["icon"]): NavGroup[] => (items.length ? [{ label, icon, items }] : []);

/**
 * Skarn (projects / airdrops): the "Protocols" wrapper becomes Projects /
 * Tasks / Content. The existing Category tree stays NESTED under Projects
 * (minus the Task link, which moves to Tasks). The admin "Protocols" group
 * (/admin/...) is not matched.
 */
export const skarnNav: ModuleNavConfig = {
  isWrapper: (g) => labelIs(g, "protocols") && allLeavesUnder(g, ["/projects", "/tasks", "/content"]),
  build: (wrapper) => {
    const t = takeLeaves(wrapper.items, (l) => under(l.href, "/tasks"));
    const c = takeLeaves(t.rest, (l) => under(l.href, "/content"));
    return [
      ...group("Projects", c.rest, (c.rest[0] as { icon?: NavGroup["icon"] } | undefined)?.icon ?? wrapper.icon),
      ...group("Tasks", t.taken, t.taken[0]?.icon ?? wrapper.icon),
      ...group("Content", c.taken, c.taken[0]?.icon ?? wrapper.icon),
    ];
  },
};
