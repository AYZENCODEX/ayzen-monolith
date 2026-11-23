/**
 * Sylo navigation tree — the single source of truth for the rail and the
 * mobile bottom bar. Mirrors the approved prototype (design/sylo-redesign).
 *
 * `match` lists the path prefixes that light an item up, most specific first,
 * so a detail page (/vault/entity/12) keeps its list highlighted.
 */
import { accountPath } from "@/lib/sylo-routes";

export type Tone = "brass" | "patina" | "copper" | "slate" | "moss" | "rose";

export interface NavLeaf { key: string; label: string; href: string; tone?: Tone; match: string[] }
export interface NavGroup { key: string; label: string; tone: Tone; href: string; match: string[]; kids?: NavLeaf[] }

export const NAV: NavGroup[] = [
  { key: "console", label: "Console", tone: "brass", href: "/vault", match: ["="] },
  {
    key: "accounts", label: "Accounts", tone: "brass", href: accountPath("entity", "management"), match: [],
    kids: [
      { key: "entity", label: "Entity", href: accountPath("entity", "management"), tone: "brass", match: ["/vault/account/entity", "/vault/entity"] },
      { key: "local", label: "Local accounts", href: accountPath("local", "management"), tone: "patina", match: ["/vault/account/local", "/vault/local"] },
      { key: "game", label: "Game accounts", href: accountPath("game", "management"), tone: "slate", match: ["/vault/account/game"] },
      { key: "enrollment", label: "Enrollment", href: "/vault/enrollment/overview", tone: "slate", match: ["/vault/enrollment", "/vault/projects"] },
    ],
  },
  {
    key: "kyc", label: "KYC", tone: "copper", href: accountPath("kyc", "management"), match: [],
    kids: [
      { key: "kyc-entries", label: "KYC entries", href: accountPath("kyc", "management"), tone: "copper", match: ["/vault/account/kyc", "/vault/kyc/enrolled", "/vault/kyc/"] },
      { key: "kyc-data", label: "Data entity", href: "/vault/kyc/data/overview", tone: "copper", match: ["/vault/kyc/data"] },
    ],
  },
  {
    key: "access", label: "Access", tone: "patina", href: "/vault/access/entity", match: [],
    kids: [
      { key: "access-entity", label: "Entity", href: "/vault/access/entity", tone: "brass", match: ["/vault/access/entity"] },
      { key: "access-local", label: "Local accounts", href: "/vault/access/local", tone: "patina", match: ["/vault/access/local"] },
      { key: "access-kyc", label: "KYC", href: "/vault/access/kyc", tone: "copper", match: ["/vault/access/kyc"] },
    ],
  },
  {
    key: "records", label: "Records", tone: "brass", href: "/vault/activity", match: [],
    kids: [
      { key: "activity", label: "Activity log", href: "/vault/activity", tone: "brass", match: ["/vault/activity"] },
      { key: "shared", label: "Shared", href: "/vault/shared", tone: "brass", match: ["/vault/shared"] },
      { key: "data", label: "Import / export", href: "/vault/migration", tone: "brass", match: ["/vault/migration", "/vault/snapshot"] },
      { key: "compliance", label: "Compliance", href: "/vault/compliance", tone: "brass", match: ["/vault/compliance"] },
    ],
  },
  {
    key: "other", label: "Other", tone: "patina", href: "/vault/2fa/overview", match: [],
    kids: [
      { key: "2fa", label: "Two-factor", href: "/vault/2fa/overview", tone: "patina", match: ["/vault/2fa"] },
      { key: "wallet", label: "Wallet hub", href: "/vault/wallet-hub/overview", tone: "moss", match: ["/vault/wallet-hub"] },
      { key: "backup", label: "Backup codes", href: "/vault/backup/overview", tone: "patina", match: ["/vault/backup"] },
      { key: "emergency", label: "Emergency access", href: "/vault/emergency-access", tone: "patina", match: ["/vault/emergency-access"] },
    ],
  },
  {
    key: "settings", label: "Settings", tone: "slate", href: "/vault/settings", match: ["="],
    kids: [
      { key: "security", label: "Security", href: "/vault/security", tone: "patina", match: ["/vault/security"] },
      { key: "connectors", label: "Connectors", href: "/vault/settings/connectors", tone: "slate", match: ["/vault/settings/connectors"] },
      { key: "devkeys", label: "Developer keys", href: "/developer", tone: "slate", match: ["/developer"] },
    ],
  },
];

const hit = (path: string, prefix: string) =>
  path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : prefix + "/");

/** Longest matching prefix wins, so /vault/settings/connectors beats /vault/settings. */
export function activeLeaf(path: string): { group: NavGroup | null; leaf: NavLeaf | null } {
  let best: { group: NavGroup | null; leaf: NavLeaf | null; len: number } = { group: null, leaf: null, len: -1 };
  for (const g of NAV) {
    if (g.match.includes("=") && path === g.href && g.href.length > best.len) best = { group: g, leaf: null, len: g.href.length };
    for (const k of g.kids ?? []) {
      for (const m of k.match) {
        if (hit(path, m) && m.length > best.len) best = { group: g, leaf: k, len: m.length };
      }
    }
  }
  return { group: best.group, leaf: best.leaf };
}

export const MOBILE_BAR: { label: string; href: string; group: string }[] = [
  { label: "Home", href: "/vault", group: "console" },
  { label: "Accounts", href: accountPath("entity", "management"), group: "accounts" },
  { label: "Access", href: "/vault/access/entity", group: "access" },
  { label: "Records", href: "/vault/activity", group: "records" },
  { label: "Settings", href: "/vault/settings", group: "settings" },
];

/** Groups that light the same mobile tab (KYC is reached through Accounts on mobile). */
export const MOBILE_GROUP_ALIAS: Record<string, string> = { kyc: "accounts", other: "records" };
