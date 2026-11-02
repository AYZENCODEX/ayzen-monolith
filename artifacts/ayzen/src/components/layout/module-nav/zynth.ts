import { allLeavesUnder, labelIs } from "./helpers";
import type { ModuleNavConfig } from "./restructure";

/** Zynth (AI assistant): rename only. The inherited "Social" label becomes "Assistant". */
export const zynthNav: ModuleNavConfig = {
  isWrapper: (group) => labelIs(group, "social") && allLeavesUnder(group, ["/assistant"]),
  build: (wrapper) => [{ label: "Assistant", icon: wrapper.items[0]?.icon ?? wrapper.icon, items: wrapper.items }],
};
