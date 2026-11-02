import { allLeavesUnder, labelIs } from "./helpers";
import type { ModuleNavConfig } from "./restructure";

/**
 * Warde (teams): the "Team" wrapper is dissolved; its four sections become
 * top-level: Overview / Progress / Finance / Panel. ("Panel" is team admin and
 * is separate from the module Settings page.)
 */
export const wardeNav: ModuleNavConfig = {
  isWrapper: (group) => labelIs(group, "team") && allLeavesUnder(group, ["/teams", "/team_leader"]),
  order: ["Overview", "Progress", "Finance", "Panel"],
  fallbackSection: "Overview",
};
