import { useState } from "react";
import { useLocation, useSearch } from "wouter";
import { ArrowLeft } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { usePlugins } from "@/hooks/use-plugins";
import {
  type NavGroup,
  NavGroupComp,
  ProfileQuickAccess,
  SidebarAiPanel,
  AdminProjectsSidebarSection,
  useRoleNavGroups,
  filterGroupsBySubdomain,
} from "./app-sidebar";
import { centralUrl, moduleUrl, type SubdomainApp } from "@/lib/subdomain-app";

/**
 * components/layout/module-sidebar.tsx
 * Module Shell Split — Season 2.
 *
 * Dedicated sidebar for a module subdomain (sylo.ayzen.tech, skarn.ayzen.tech,
 * ...): module icon + label header, a pinned "<- AYZEN" back link to the
 * central domain (plain <a> because it is cross-origin), only that module's
 * role-based nav (same DB-driven useNavConfig merge as central, filtered by
 * the module's routePrefixes), profile quick access at the bottom.
 *
 * The AI panel renders on zynth only (the assistant IS the module there);
 * other modules don't get it. Central sidebar is untouched (see
 * CentralSidebar in app-sidebar.tsx).
 */

// Admin-only dynamic project list: project/airdrop-farming data, so it
// belongs to Skarn's surface only (same rule the central sidebar applies).
const ADMIN_PROJECTS_MODULE_IDS = new Set(["skarn"]);

export function ModuleSidebar({ app, onNavigate }: { app: SubdomainApp; onNavigate?: () => void }) {
  const [location] = useLocation();
  const search = useSearch();
  const { isAdmin, isDev, logout, user } = useAuth();
  const { isEnabled } = usePlugins();
  const { groups: allGroups } = useRoleNavGroups();
  const scopedGroups = filterGroupsBySubdomain(allGroups, app);

  const home = moduleUrl(app.id, app.homePath);

  return (
    <div className="flex h-full flex-col bg-sidebar border-r border-sidebar-border text-sidebar-foreground" style={{ width: "var(--sidebar-w, 16rem)" }}>
      {/* Module header: icon + label, and the pinned back link */}
      <div className="p-4 border-b border-sidebar-border">
        <div className="flex items-center gap-2 font-mono text-xl font-bold tracking-tighter text-primary">
          {app.icon ? <app.icon className="w-5 h-5" /> : null}
          <span className="flex-1">{app.label}</span>
        </div>
        {/* Cross-origin -> plain anchor, full navigation, same shared session cookie */}
        <a
          href={centralUrl("/")}
          className="mt-2 w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[11px] font-mono text-muted-foreground hover:bg-primary/10 hover:text-primary border border-transparent hover:border-primary/40 transition-all"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          AYZEN
        </a>
      </div>

      <ProfileQuickAccess user={user} logout={logout} navigate={(to: string) => { window.location.href = moduleUrl(app.id, to); onNavigate?.(); }} onNavigate={onNavigate} />

      <div className="flex-1 overflow-y-auto py-2 space-y-1">
        {scopedGroups.map(group => (
          <NavGroupComp key={group.label} group={group} location={location} search={search} isEnabled={isEnabled} onNavigate={onNavigate} />
        ))}

        {(isAdmin || isDev) && ADMIN_PROJECTS_MODULE_IDS.has(app.id) && (
          <AdminProjectsSidebarSection onNavigate={onNavigate} location={location} />
        )}
      </div>

      {app.id === "zynth" && <SidebarAiPanel />}
    </div>
  );
}
