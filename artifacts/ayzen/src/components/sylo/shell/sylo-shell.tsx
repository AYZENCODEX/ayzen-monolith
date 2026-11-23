/**
 * SyloShell — the app frame for every /vault route: brand rail with the
 * hierarchical tree, top bar with breadcrumb + search, and a bottom tab bar
 * below 900px. Pages render inside `.page`. Styling lives in styles/sylo-ui.css
 * and is scoped under `.sx`, so nothing here leaks to the rest of the app.
 */
import { type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { GlobalSearch } from "@/components/global-search";
import { NAV, MOBILE_BAR, MOBILE_GROUP_ALIAS, activeLeaf, type Tone } from "./nav";
import { InSylo } from "./context";
import "@/styles/sylo-ui.css";

const COL: Record<Tone, string> = {
  brass: "var(--brass)", patina: "var(--patina)", copper: "var(--copper)",
  slate: "var(--slate)", moss: "var(--moss)", rose: "var(--rose)",
};

function crumbsFor(path: string): string[] {
  const { group, leaf } = activeLeaf(path);
  const out = ["Sylo"];
  if (group && group.key !== "console") out.push(group.label);
  if (leaf) out.push(leaf.label);
  return out;
}

export function SyloShell({ children }: { children: ReactNode }) {
  const [path] = useLocation();
  const { user } = useAuth();
  const { group, leaf } = activeLeaf(path);
  const tone: Tone = leaf?.tone ?? group?.tone ?? "brass";
  const crumbs = crumbsFor(path);
  const initials = (user?.username ?? "SY").slice(0, 2).toUpperCase();
  const mobileGroup = group ? (MOBILE_GROUP_ALIAS[group.key] ?? group.key) : "console";

  return (
    <div className={`sx t-${tone}`}>
      <aside className="rail" aria-label="Sylo navigation">
        <div className="brand"><i /><b>SYLO</b></div>
        <div className="ws">
          <div>{user?.username ?? "Workspace"}<small>VAULT · PRIVATE</small></div>
          <span className="mono" style={{ color: "var(--di)" }}>⌄</span>
        </div>
        <nav className="nav">
          {NAV.map((g) => (
            <div key={g.key}>
              <Link href={g.href} className={group?.key === g.key && !leaf ? "on" : ""} style={{ ["--c" as string]: COL[g.tone] }}>
                <span className="d" />{g.label}
                {g.kids && <em className="chev">⌄</em>}
              </Link>
              {g.kids && (
                <div className="subnav">
                  {g.kids.map((k) => (
                    <Link key={k.key} href={k.href} className={leaf?.key === k.key ? "on" : ""} style={{ ["--c" as string]: COL[k.tone ?? g.tone] }}>
                      {k.label}<em />
                    </Link>
                  ))}
                </div>
              )}
            </div>
          ))}
        </nav>
        <div className="lock"><p>Vault unlocked</p><small>Protected by your vault PIN</small></div>
      </aside>

      <div className="main">
        <div className="top">
          <div className="crumb">
            {crumbs.map((c, i) => i === crumbs.length - 1
              ? <b key={i}>{c}</b>
              : <span key={i} style={{ display: "contents" }}><span>{c}</span><span>/</span></span>)}
          </div>
          <div className="search" role="search"><GlobalSearch isAdmin={user?.role === "admin"} /></div>
          <div className="av" aria-label="Account">{initials}</div>
        </div>
        <div className="page"><InSylo.Provider value={true}>{children}</InSylo.Provider></div>
      </div>

      <nav className="mbar" aria-label="Sylo tabs">
        {MOBILE_BAR.map((t) => (
          <Link key={t.group} href={t.href} className={mobileGroup === t.group ? "on" : ""}>{t.label}</Link>
        ))}
      </nav>
    </div>
  );
}
