/**
 * Module sidebar restructure (Phase 6).
 *
 * The module sidebar is built by filtering the CENTRAL nav groups down to the
 * module's routes, so a module inherits the central shape (e.g. Sylo gets one
 * "Vault" group wrapping Account / Access / Enrollment / Other). A
 * ModuleNavConfig dissolves that wrapper at render time: each section inside
 * it becomes its own top-level sidebar group.
 *
 * It runs AFTER role filtering and the DB-driven nav merge (useRoleNavGroups +
 * filterGroupsBySubdomain), so those keep working, and nothing in the nav
 * tables or the Sidebar Builder is rewritten. Pure and dependency-free (type
 * imports only) so it can be unit-tested.
 */
import type { NavGroup } from "../app-sidebar";

type Entry = NavGroup["items"][number];
export type Leaf = Extract<Entry, { href: string }>;

export interface ModuleNavConfig {
  /** True for the central wrapper group(s) this module dissolves. */
  isWrapper: (group: NavGroup) => boolean;
  /**
   * Full control: replace one wrapper with these groups (used when sections must
   * stay nested, e.g. Skarn's Category tree). When set, `order`, `rename`,
   * `fallbackSection`, `leafSection`, `postProcess` and `pinned` are not used.
   */
  build?: (wrapper: NavGroup) => NavGroup[];
  /** Top-level section order by (renamed) label. Sections not listed keep their order after these. */
  order?: readonly string[];
  /** Label renames applied to promoted sections, e.g. { Enrollment: "Enroll" }. Sections that end up with the same label are merged. */
  rename?: Readonly<Record<string, string>>;
  /** Section that receives leaves sitting directly under the wrapper (they have no section of their own). */
  fallbackSection?: string;
  /** Optional per-leaf routing of loose leaves to a named section (falls back to `fallbackSection`). */
  leafSection?: (leaf: Leaf) => string | undefined;
  /** Optional final adjustment of the promoted sections (e.g. relabel a leaf after a merge). */
  postProcess?: (sections: NavGroup[]) => NavGroup[];
  /** Optional pinned entry placed first, so the wrapper's own hub link is not lost when the wrapper goes. */
  pinned?: NavGroup;
}

const isSection = (entry: Entry): entry is Exclude<Entry, Leaf> => (entry as { children?: unknown }).children !== undefined;

export function restructureModuleGroups(config: ModuleNavConfig, groups: NavGroup[]): NavGroup[] {
  const promoted = new Map<string, NavGroup>();
  const looseLeaves: Entry[] = [];
  const out: NavGroup[] = [];
  let replacedAt = -1;

  if (config.build) {
    let built = false;
    const result: NavGroup[] = [];
    for (const group of groups) {
      if (config.isWrapper(group)) { result.push(...config.build(group)); built = true; }
      else result.push(group);
    }
    return built ? result : groups;
  }

  for (const group of groups) {
    if (!config.isWrapper(group)) { out.push(group); continue; }
    if (replacedAt === -1) replacedAt = out.length;
    for (const item of group.items) {
      if (!isSection(item)) { looseLeaves.push(item); continue; }
      const label = config.rename?.[item.label] ?? item.label;
      const existing = promoted.get(label);
      if (existing) existing.items.push(...item.children);
      else promoted.set(label, { label, icon: item.icon, items: [...item.children], ...(item.pluginSlug ? { pluginSlug: item.pluginSlug } : {}) });
    }
  }

  if (replacedAt === -1) return groups; // nothing to dissolve on this nav (e.g. a role without Vault)

  const fallback = config.fallbackSection ?? "Other";
  for (const entry of looseLeaves) {
    const label = config.leafSection?.(entry as Leaf) ?? fallback;
    const target = promoted.get(label);
    if (target) target.items.push(entry);
    else promoted.set(label, { label, icon: (entry as Leaf).icon, items: [entry] });
  }

  const rank = (label: string) => { const order = config.order ?? []; const i = order.indexOf(label); return i === -1 ? order.length : i; };
  const sections = [...promoted.values()]
    .map((group, index) => ({ group, index }))
    .sort((a, b) => rank(a.group.label) - rank(b.group.label) || a.index - b.index)
    .map(({ group }) => group);

  const finalSections = config.postProcess ? config.postProcess(sections) : sections;
  const replacement = config.pinned ? [config.pinned, ...finalSections] : finalSections;
  return [...out.slice(0, replacedAt), ...replacement, ...out.slice(replacedAt)];
}
