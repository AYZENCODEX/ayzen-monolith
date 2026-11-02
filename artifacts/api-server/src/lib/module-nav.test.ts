import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { restructureModuleGroups } from "../../../ayzen/src/components/layout/module-nav/restructure";
import { applyModuleNav, MODULE_NAV } from "../../../ayzen/src/components/layout/module-nav/index";
import { syloNav } from "../../../ayzen/src/components/layout/module-nav/sylo";

const Icon = (() => null) as never;
const leaf = (href: string, label: string) => ({ href, label, icon: Icon });
const section = (label: string, children: unknown[], extra: object = {}) => ({ label, icon: Icon, children, ...extra });

// Same shape as the "Vault" group in USER_NAV / ADMIN_NAV (app-sidebar.tsx).
const vaultGroup = (withHref = true) => ({
  label: "Vault", icon: Icon, ...(withHref ? { href: "/vault/hub" } : {}),
  items: [
    section("Account", [leaf("/vault?tab=entity", "Entity"), leaf("/vault?tab=local", "Local")]),
    section("Access", [leaf("/vault/2fa/overview", "2FA"), leaf("/vault/backup/overview", "Backup Code")]),
    section("Enrollment", [leaf("/vault/enrollment/overview", "Overview"), leaf("/vault/projects", "Enroll")]),
    section("Other", [leaf("/vault/shared", "Shared"), leaf("/vault/trash", "Trash")]),
  ],
}) as never;

const labels = (groups: Array<{ label: string }>) => groups.map((g) => g.label);

test("Sylo: the Vault wrapper is dissolved into Account / Access / Enroll / Other", () => {
  const out = restructureModuleGroups(syloNav, [vaultGroup()]);
  assert.deepEqual(labels(out), ["Hub", "Account", "Access", "Enroll", "Other"]);
  assert.ok(!labels(out).includes("Vault"));
  assert.deepEqual(out[1].items.map((i: any) => i.label), ["Entity", "Local"]);
  assert.deepEqual(out[3].items.map((i: any) => i.label), ["Overview", "Enroll"], "Enrollment renamed to Enroll, children kept");
  assert.equal((out[0].items[0] as any).href, "/vault/hub", "the wrapper's hub link stays reachable");
});

test("works on the DB-driven nav (no group href) too", () => {
  const out = restructureModuleGroups(syloNav, [vaultGroup(false)]);
  assert.deepEqual(labels(out), ["Hub", "Account", "Access", "Enroll", "Other"]);
});

test("every leaf survives, none duplicated", () => {
  const hrefs = (gs: any[]): string[] => gs.flatMap((g) => g.items.flatMap(function walk(e: any): string[] { return e.children ? e.children.flatMap(walk) : [e.href]; }));
  const before = hrefs([vaultGroup()]);
  const after = hrefs(restructureModuleGroups(syloNav, [vaultGroup()])).filter((h) => h !== "/vault/hub");
  assert.deepEqual(after.sort(), before.sort());
});

test("order is enforced even if the source order differs; unknown sections go last", () => {
  const g: any = vaultGroup();
  g.items = [g.items[3], section("Extras", [leaf("/vault/x", "X")]), g.items[2], g.items[1], g.items[0]];
  assert.deepEqual(labels(restructureModuleGroups(syloNav, [g])), ["Hub", "Account", "Access", "Enroll", "Other", "Extras"]);
});

test("admin and non-vault groups are untouched and keep their position", () => {
  const admin: any = { label: "Team Vault", icon: Icon, items: [leaf("/admin/team-vault", "Team Vault")] };
  const adminVault: any = { label: "Vault", icon: Icon, items: [leaf("/admin/vault", "Entities")] };
  const out = restructureModuleGroups(syloNav, [adminVault, vaultGroup(), admin]);
  assert.deepEqual(labels(out), ["Vault", "Hub", "Account", "Access", "Enroll", "Other", "Team Vault"]);
  assert.equal(out[0], adminVault, "an admin 'Vault' group is not mistaken for the user wrapper");
});

test("loose leaves under the wrapper land in Other; a plugin gate on a section is kept", () => {
  const g: any = vaultGroup();
  g.items.push(leaf("/vault/loose", "Loose"));
  g.items[0] = section("Account", [leaf("/vault?tab=entity", "Entity")], { pluginSlug: "vault" });
  const out = restructureModuleGroups(syloNav, [g]);
  assert.ok(out.find((x) => x.label === "Other")!.items.some((i: any) => i.href === "/vault/loose"));
  assert.equal(out.find((x) => x.label === "Account")!.pluginSlug, "vault");
});

test("no wrapper present: groups come back unchanged (same array)", () => {
  const groups: any[] = [{ label: "Team", icon: Icon, items: [leaf("/teams", "Teams")] }];
  assert.equal(restructureModuleGroups(syloNav, groups), groups);
});

test("modules without a config keep the inherited sidebar", () => {
  const groups: any[] = [vaultGroup()];
  assert.equal(applyModuleNav("ryft", groups), groups);
  assert.deepEqual(Object.keys(MODULE_NAV).sort(), ["fyra", "skarn", "sylo", "verve", "warde", "wisp", "zynth"]);
});

test("the real central nav still has the Vault group shape this config expects", () => {
  const source = readFileSync(new URL("../../../ayzen/src/components/layout/app-sidebar.tsx", import.meta.url), "utf8");
  const start = source.indexOf('label: "Vault", icon: Vault, href: "/vault/hub"');
  assert.notEqual(start, -1);
  const block = source.slice(start, start + 2600);
  for (const section of ['label: "Account"', 'label: "Access"', 'label: "Enrollment"', 'label: "Other"']) assert.ok(block.includes(section), section);
});

test("module sidebar applies the restructure after role + subdomain filtering", () => {
  const source = readFileSync(new URL("../../../ayzen/src/components/layout/module-sidebar.tsx", import.meta.url), "utf8");
  assert.match(source, /applyModuleNav\(app\.id, filterGroupsBySubdomain\(allGroups, app\)\)/);
});
