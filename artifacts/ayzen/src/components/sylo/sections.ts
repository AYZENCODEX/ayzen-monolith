/**
 * components/sylo/sections.ts
 * Static metadata for the Account sections and their views. Pure data — no
 * components — so routing, nav and pages share one definition.
 */
import {
  BarChart3, Gamepad2, LayoutDashboard, LayoutGrid, Settings2, Shield, ShieldCheck, Smartphone,
  type LucideIcon,
} from "lucide-react";
import type { AccountSection, AccountView } from "@/lib/sylo-routes";

export interface SectionMeta { label: string; description: string; icon: LucideIcon }
export interface ViewMeta { label: string; icon: LucideIcon }

export const SECTION_META: Record<AccountSection, SectionMeta> = {
  entity: {
    label: "Entity",
    description: "Projects and the social, wallet and email identities you operate under them.",
    icon: Shield,
  },
  local: {
    label: "Local accounts",
    description: "Standalone accounts stored locally, outside any entity.",
    icon: Smartphone,
  },
  kyc: {
    label: "KYC",
    description: "Verified-identity accounts, with payment and ownership status.",
    icon: ShieldCheck,
  },
  game: {
    label: "Game accounts",
    description: "Game and platform accounts you track.",
    icon: Gamepad2,
  },
};

export const VIEW_META: Record<AccountView, ViewMeta> = {
  home: { label: "Home", icon: LayoutGrid },
  dashboard: { label: "Dashboard", icon: LayoutDashboard },
  analysis: { label: "Analysis", icon: BarChart3 },
  management: { label: "Management", icon: Settings2 },
};

/** Game accounts only have a management surface today; the rest get all four. */
export const SECTION_VIEWS: Record<AccountSection, readonly AccountView[]> = {
  entity: ["home", "dashboard", "analysis", "management"],
  local: ["home", "dashboard", "analysis", "management"],
  kyc: ["home", "dashboard", "analysis", "management"],
  game: ["management"],
};

export const VIEW_BLURB: Record<Exclude<AccountView, "home">, string> = {
  dashboard: "Live portfolio overview with category and activity breakdowns.",
  analysis: "Distribution, returns and performance charts.",
  management: "Create, edit, import and remove records.",
};
