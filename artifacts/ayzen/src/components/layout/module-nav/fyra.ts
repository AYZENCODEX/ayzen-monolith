import type { NavGroup } from "../app-sidebar";
import { allLeavesUnder, isLeaf, labelIs } from "./helpers";
import type { ModuleNavConfig } from "./restructure";

/**
 * Fyra (finance): the central "Finance" wrapper is dissolved and its sections
 * are promoted, with Investments + Assets + Goals merged into one "Wealth"
 * section (each of those had a single link). Result:
 * Overview / Cash Flow / Loans / Wealth / Expenses / Accounting / Invoices / Reports.
 * Admin finance groups (/admin/...) are not matched.
 */
export const fyraNav: ModuleNavConfig = {
  isWrapper: (group) => labelIs(group, "finance") && allLeavesUnder(group, ["/finance"]),
  order: ["Overview", "Cash Flow", "Loans", "Wealth", "Expenses", "Accounting", "Invoices", "Reports"],
  rename: { Investments: "Wealth", Assets: "Wealth", Goals: "Wealth" },
  fallbackSection: "Overview",
  // Assets' single link is just "Overview"; inside Wealth that would be ambiguous.
  postProcess: (sections: NavGroup[]) =>
    sections.map((section) =>
      section.label !== "Wealth"
        ? section
        : { ...section, items: section.items.map((item) => (isLeaf(item) && item.label === "Overview" ? { ...item, label: "Assets Overview" } : item)) },
    ),
};
