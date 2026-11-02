import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { applyModuleNav } from "../../../ayzen/src/components/layout/module-nav/index";

const Icon = (() => null) as never;
const leaf = (href: string, label: string) => ({ href, label, icon: Icon });
const section = (label: string, children: unknown[]) => ({ label, icon: Icon, children });
const group = (label: string, items: unknown[], extra: object = {}) => ({ label, icon: Icon, items, ...extra }) as never;
const labels = (gs: Array<{ label: string }>) => gs.map((g) => g.label);
const hrefsOf = (gs: any[]): string[] => gs.flatMap((g) => g.items.flatMap(function walk(e: any): string[] { return e.children ? e.children.flatMap(walk) : [e.href]; }));
const names = (g: any) => g.items.map((i: any) => i.label);

// ── Fyra ──────────────────────────────────────────────────────────────────────
const financeGroup = () => group("Finance", [
  section("Overview", [leaf("/finance/dashboard", "Dashboard"), leaf("/finance/analytics", "Analytics"), leaf("/finance/projections", "Projections")]),
  section("Cash Flow", [leaf("/finance/receivables", "Receivables"), leaf("/finance/payables", "Payables")]),
  section("Loans", [leaf("/finance/loans/borrowed", "Borrowed Funds"), leaf("/finance/loans/lending", "Lending")]),
  section("Investments", [leaf("/finance/investments", "All Projects")]),
  section("Assets", [leaf("/finance/assets", "Overview")]),
  section("Goals", [leaf("/finance/goals", "Goals & Net Worth")]),
  section("Expenses", [leaf("/finance/expenses", "Expenses"), leaf("/finance/budgets", "Budgets")]),
  section("Accounting", [leaf("/finance/books", "Books")]),
  section("Invoices", [leaf("/finance/invoices", "Invoices")]),
  section("Reports", [leaf("/finance/pnl", "PnL")]),
]);

test("Fyra: Finance wrapper dissolved; Investments + Assets + Goals merge into Wealth", () => {
  const out = applyModuleNav("fyra", [financeGroup()]);
  assert.deepEqual(labels(out), ["Overview", "Cash Flow", "Loans", "Wealth", "Expenses", "Accounting", "Invoices", "Reports"]);
  assert.deepEqual(names(out[3]), ["All Projects", "Assets Overview", "Goals & Net Worth"]);
  assert.deepEqual(hrefsOf(out).sort(), hrefsOf([financeGroup()]).sort(), "every link survives, none duplicated");
});

test("Fyra: the admin Finance group is not mistaken for the wrapper", () => {
  const admin = group("Finance", [leaf("/admin/finance", "Finance")]);
  const out = applyModuleNav("fyra", [admin]);
  assert.equal(out[0], admin);
});

// ── Verve ─────────────────────────────────────────────────────────────────────
const marketGroup = () => group("Market", [
  section("Market", [leaf("/marketplace/azn", "Official Market"), section("Vault Market", [leaf("/marketplace/vault?type=kyc", "KYC")]), section("Polymarket", [leaf("/marketplace/polymarket?tab=overview", "Overview")]), leaf("/marketplace", "P2P Market")]),
  leaf("/marketplace/wallet", "Market Wallet"),
  leaf("/marketplace/order-history", "Order History"),
], { href: "/marketplace/hub" });

test("Verve: Hub / Market / Wallet / Orders; nested folders stay nested", () => {
  const out = applyModuleNav("verve", [marketGroup()]);
  assert.deepEqual(labels(out), ["Hub", "Market", "Wallet", "Orders"]);
  assert.deepEqual(names(out[1]), ["Official Market", "Vault Market", "Polymarket", "P2P Market"]);
  assert.deepEqual(names(out[2]), ["Market Wallet"]);
  assert.deepEqual(names(out[3]), ["Order History"]);
  assert.equal((out[0].items[0] as any).href, "/marketplace/hub");
  assert.deepEqual(hrefsOf(out).filter((h) => h !== "/marketplace/hub").sort(), hrefsOf([marketGroup()]).sort());
});

// ── Skarn ─────────────────────────────────────────────────────────────────────
// Same shape as the real USER_NAV: the "Task" link is the last child INSIDE the
// Category section, and "Content" is a loose leaf of the wrapper.
const protocolsGroup = () => group("Protocols", [
  leaf("/projects", "Project"),
  section("Category", [section("Exchange", [leaf("/projects?rollup=Exchange", "Overview")]), section("Web3", [leaf("/projects?type=web3-dex", "Dex")]), leaf("/tasks", "Task")]),
  leaf("/content", "Content"),
]);

test("Skarn: Projects (Category tree nested) / Tasks (Task pulled out of Category) / Content", () => {
  const out = applyModuleNav("skarn", [protocolsGroup()]);
  assert.deepEqual(labels(out), ["Projects", "Tasks", "Content"]);
  assert.deepEqual(names(out[0]), ["Project", "Category"]);
  assert.deepEqual((out[0].items[1] as any).children.map((c: any) => c.label), ["Exchange", "Web3"], "Category tree unchanged apart from Task");
  assert.deepEqual(names(out[1]), ["Task"]);
  assert.deepEqual(names(out[2]), ["Content"]);
  assert.deepEqual(hrefsOf(out).sort(), hrefsOf([protocolsGroup()]).sort(), "every link survives, none duplicated");
});

test("Skarn: Task/Content as loose leaves of the wrapper work too", () => {
  const g = group("Protocols", [leaf("/projects", "Project"), leaf("/tasks", "Task"), leaf("/content", "Content")]);
  assert.deepEqual(labels(applyModuleNav("skarn", [g])), ["Projects", "Tasks", "Content"]);
});

test("Skarn: a section that only held Task is dropped, not left empty", () => {
  const g = group("Protocols", [leaf("/projects", "Project"), section("Solo", [leaf("/tasks", "Task")])]);
  const out = applyModuleNav("skarn", [g]);
  assert.deepEqual(labels(out), ["Projects", "Tasks"]);
  assert.deepEqual(names(out[0]), ["Project"]);
});

test("Skarn: admin Protocols group is untouched", () => {
  const admin = group("Protocols", [leaf("/admin/projects", "Projects")]);
  assert.equal(applyModuleNav("skarn", [admin])[0], admin);
});

// ── Warde ─────────────────────────────────────────────────────────────────────
const teamGroup = () => group("Team", [
  section("Overview", [leaf("/teams", "Team Home"), leaf("/teams?tab=members", "Members")]),
  section("Progress", [leaf("/teams?tab=tasks", "Tasks")]),
  section("Finance", [leaf("/teams?tab=vault", "Team Vault")]),
  section("Panel", [leaf("/teams?tab=panel", "Team Settings")]),
]);

test("Warde: Overview / Progress / Finance / Panel", () => {
  const out = applyModuleNav("warde", [teamGroup()]);
  assert.deepEqual(labels(out), ["Overview", "Progress", "Finance", "Panel"]);
  assert.deepEqual(hrefsOf(out).sort(), hrefsOf([teamGroup()]).sort());
});

// ── Wisp (B2) ────────────────────────────────────────────────────────────────
test("Wisp B2: Mailbox + Accounts (Email Accounts, AYZEN Email setup)", () => {
  const out = applyModuleNav("wisp", [group("Social", [leaf("/mailbox", "AYZEN Mail")])]);
  assert.deepEqual(labels(out), ["Mailbox", "Accounts"]);
  assert.deepEqual(out[1].items.map((i: any) => i.href), ["/email-accounts", "/ayzen-email"]);
  assert.deepEqual(names(out[0]), ["AYZEN Mail"]);
});

test("Wisp B2: links already present (DB-driven nav) are not duplicated", () => {
  const out = applyModuleNav("wisp", [group("Social", [leaf("/mailbox", "AYZEN Mail"), leaf("/email-accounts", "Email Accounts")])]);
  assert.deepEqual(out[1].items.map((i: any) => i.href), ["/ayzen-email"]);
  const all = applyModuleNav("wisp", [group("Social", [leaf("/mailbox", "M"), leaf("/email-accounts", "E"), leaf("/ayzen-email", "A")])]);
  assert.deepEqual(labels(all), ["Mailbox"], "no empty Accounts section");
});

test("Wisp/Zynth: a Social group with foreign links is left alone", () => {
  const social = group("Social", [leaf("/mailbox", "AYZEN Mail"), leaf("/inbox", "Message")]);
  assert.equal(applyModuleNav("wisp", [social])[0], social);
});

// ── Zynth ────────────────────────────────────────────────────────────────────
test("Zynth: Social renamed to Assistant", () => {
  const out = applyModuleNav("zynth", [group("Social", [leaf("/assistant", "Zynth AI")])]);
  assert.deepEqual(labels(out), ["Assistant"]);
  assert.deepEqual(names(out[0]), ["Zynth AI"]);
});

// ── Ryft ─────────────────────────────────────────────────────────────────────
test("Ryft: intentionally unchanged", () => {
  const groups = [group("Wallet", [leaf("/wallet", "My Wallet")])];
  assert.equal(applyModuleNav("ryft", groups), groups);
});

// ── Source-shape guards: fail loudly if the central nav drifts ───────────────
test("the central USER_NAV still has the wrapper shapes these configs expect", () => {
  const src = readFileSync(new URL("../../../ayzen/src/components/layout/app-sidebar.tsx", import.meta.url), "utf8");
  const userNav = src.slice(src.indexOf("const USER_NAV: NavGroup[]"));
  const must: Array<[string, string[]]> = [
    ['label: "Finance", icon: Coins,', ['label: "Overview"', 'label: "Cash Flow"', 'label: "Loans"', 'label: "Investments"', 'label: "Assets"', 'label: "Goals"', 'label: "Expenses"', 'label: "Accounting"', 'label: "Invoices"', 'label: "Reports"']],
    ['label: "Market", icon: Store, href: "/marketplace/hub"', ['href: "/marketplace/wallet"', 'href: "/marketplace/order-history"']],
    ['label: "Protocols", icon: FolderGit2,', ['label: "Category"', 'href: "/tasks"', 'href: "/content"']],
    ['label: "Team", icon: Users,', ['label: "Overview"', 'label: "Progress"', 'label: "Finance"', 'label: "Panel"']],
    ['label: "Social", icon: MessageCircle,', ['href: "/mailbox"', 'href: "/assistant"']],
  ];
  for (const [head, needles] of must) {
    const at = userNav.indexOf(head);
    assert.notEqual(at, -1, head);
    const block = userNav.slice(at, at + 30000);
    for (const n of needles) assert.ok(block.includes(n), `${head} -> ${n}`);
  }
});
