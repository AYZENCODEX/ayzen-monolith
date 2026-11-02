import { LayoutDashboard } from "lucide-react";
import { allLeavesUnder, labelIs } from "./helpers";
import type { ModuleNavConfig } from "./restructure";

/**
 * Verve (marketplace): the "Market" wrapper keeps its Market section (Official,
 * P2P, Vault Market, Polymarket folders) and the two loose links become their
 * own sections: Wallet (Market Wallet) and Orders (Order History). The
 * wrapper's header link to the hub is kept as a pinned "Hub" entry.
 */
export const verveNav: ModuleNavConfig = {
  isWrapper: (group) => labelIs(group, "market") && allLeavesUnder(group, ["/marketplace"]),
  order: ["Market", "Wallet", "Orders"],
  fallbackSection: "Market",
  leafSection: (leaf) => (leaf.href === "/marketplace/wallet" ? "Wallet" : leaf.href === "/marketplace/order-history" ? "Orders" : undefined),
  pinned: { label: "Hub", icon: LayoutDashboard, items: [{ href: "/marketplace/hub", label: "Market Hub", icon: LayoutDashboard }] },
};
