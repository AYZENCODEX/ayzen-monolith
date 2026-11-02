import { AtSign, Mail } from "lucide-react";
import { allLeavesUnder, labelIs, leafHrefs } from "./helpers";
import type { ModuleNavConfig } from "./restructure";

const ACCOUNT_LINKS = [
  { href: "/email-accounts", label: "Email Accounts", icon: Mail },
  { href: "/ayzen-email", label: "AYZEN Email setup", icon: AtSign },
];

/**
 * Wisp (mailbox): the inherited "Social" label is replaced by "Mailbox", and an
 * "Accounts" section links two existing routes that had no nav entry:
 * Email Accounts and AYZEN Email setup.
 */
export const wispNav: ModuleNavConfig = {
  isWrapper: (group) => labelIs(group, "social") && allLeavesUnder(group, ["/mailbox", "/email-accounts", "/ayzen-email"]),
  build: (wrapper) => {
    const present = new Set(leafHrefs(wrapper.items));
    const accounts = ACCOUNT_LINKS.filter((link) => !present.has(link.href));
    return [
      { label: "Mailbox", icon: Mail, items: wrapper.items },
      ...(accounts.length ? [{ label: "Accounts", icon: AtSign, items: accounts }] : []),
    ];
  },
};
