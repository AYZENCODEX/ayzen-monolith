import { useState } from "react";
import { ChevronDown, LayoutGrid } from "lucide-react";
import { getAllModules, moduleUrl, type SubdomainApp } from "@/lib/subdomain-app";
import { useAuth } from "@/hooks/use-auth";

/**
 * components/layout/apps-menu.tsx
 * Module Shell Split - Season 3.
 *
 * One row at the top of the CENTRAL nav (below logo + profile): apps icon,
 * the name AYZEN, a chevron. Click expands the module list in place, click
 * again collapses. Collapsed by default; state remembered in localStorage
 * (try/catch, private-mode safe). Each module is a cross-origin full
 * navigation anchor to moduleUrl(id, homePath), with the module registry
 * icon when set.
 */
const LS_KEY = "ayzen.appsMenu.open";

export function AppsMenu() {
  const [open, setOpen] = useState(() => {
    try {
      return window.localStorage.getItem(LS_KEY) === "1";
    } catch {
      return false;
    }
  });

  const modules = getAllModules();

  const toggle = () => {
    setOpen((o) => {
      try {
        window.localStorage.setItem(LS_KEY, o ? "0" : "1");
      } catch {
        // private mode etc. - collapse state is best-effort
      }
      return !o;
    });
  };

  return (
    <div className="border-b border-sidebar-border">
      <button
        onClick={toggle}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-sidebar-accent/50 transition-colors"
      >
        <div className="w-7 h-7 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center text-primary flex-shrink-0">
          <LayoutGrid className="w-3.5 h-3.5" />
        </div>
        <span className="flex-1 text-left font-mono text-xs font-bold tracking-tight text-primary">AYZEN</span>
        <ChevronDown className={"w-3.5 h-3.5 text-muted-foreground transition-transform" + (open ? " rotate-180" : "")} />
      </button>
      {open && (
        <div className="pb-2 px-2 space-y-0.5">
          {modules.map((m) => (
            <a
              key={m.id}
              href={moduleUrl(m.id, m.homePath)}
              className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-xs font-mono text-muted-foreground hover:bg-primary/10 hover:text-primary transition-colors"
            >
              {m.icon ? <m.icon className="w-3.5 h-3.5 flex-shrink-0" /> : <LayoutGrid className="w-3.5 h-3.5 flex-shrink-0" />}
              <span className="flex-1">{m.label}</span>
              <span className="text-[10px] text-muted-foreground/50">{m.id}.ayzen.tech</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}