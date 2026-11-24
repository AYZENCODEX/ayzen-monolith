/**
 * SyloShell — the app frame for every /vault route: brand rail with the
 * hierarchical tree, top bar with breadcrumb + search, and a bottom tab bar
 * below 900px. Pages render inside `.page`. Styling lives in styles/sylo-ui.css
 * and is scoped under `.sx`, so nothing here leaks to the rest of the app.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { getCurrentSubdomainApp, getModuleForPath, moduleUrl, centralUrl } from "@/lib/subdomain-app";
import { GlobalSearch } from "@/components/global-search";
import { NAV, MOBILE_BAR, MORE_ITEMS, MOBILE_GROUP_ALIAS, activeLeaf, type Tone } from "./nav";
import { InSylo } from "./context";
import "@/styles/sylo-ui.css";

const COL: Record<Tone, string> = {
  brass: "var(--brass)", patina: "var(--patina)", copper: "var(--copper)",
  slate: "var(--slate)", moss: "var(--moss)", rose: "var(--rose)",
};

/**
 * Resolve a nav href. Inside a module host, a page owned by another module
 * (Zynth, Fyra…) or by the central app (credits, subscription) needs a full
 * navigation — the scope guard would bounce a client-side one back to /vault.
 */
function resolve(path: string): { href: string; external: boolean } {
  const current = getCurrentSubdomainApp();
  if (!current) return { href: path, external: false };
  const owner = getModuleForPath(path);
  if (owner === current.id) return { href: path, external: false };
  return { href: owner ? moduleUrl(owner, path) : centralUrl(path), external: true };
}

function NavLink({ to, className, style, children }: { to: string; className?: string; style?: React.CSSProperties; children: ReactNode }) {
  const r = resolve(to);
  return r.external
    ? <a href={r.href} className={className} style={style}>{children}</a>
    : <Link href={r.href} className={className} style={style}>{children}</Link>;
}

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
  const [more, setMore] = useState(false);
  useEffect(() => {
    document.body.classList.add("sx-portal");
    return () => document.body.classList.remove("sx-portal");
  }, []);
  useEffect(() => setMore(false), [path]);
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
              <NavLink to={g.href} className={group?.key === g.key && !leaf ? "on" : ""} style={{ ["--c" as string]: COL[g.tone] }}>
                <span className="d" />{g.label}
                {g.kids ? <em className="chev">⌄</em> : g.key === "zynth" ? <em>AI</em> : null}
              </NavLink>
              {g.kids && (
                <div className="subnav">
                  {g.kids.map((k) => (
                    <NavLink key={k.key} to={k.href} className={leaf?.key === k.key ? "on" : ""} style={{ ["--c" as string]: COL[k.tone ?? g.tone] }}>
                      {k.label}<em />
                    </NavLink>
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

      {more && (
        <div className="more-sheet" role="menu">
          {MORE_ITEMS.map((i) => <NavLink key={i.href} to={i.href} className={mobileGroup === i.group ? "on" : ""}>{i.label}</NavLink>)}
        </div>
      )}
      <nav className="mbar" aria-label="Sylo tabs">
        {MOBILE_BAR.map((t) => (
          <NavLink key={t.group} to={t.href} className={mobileGroup === t.group ? "on" : ""}>{t.label}</NavLink>
        ))}
        <button type="button" className={`more-btn${mobileGroup === "credit" || mobileGroup === "zynth" ? " on" : ""}`} aria-expanded={more} onClick={() => setMore((v) => !v)}>More</button>
      </nav>
    </div>
  );
}
