import { useLocation } from "wouter";
import { Settings } from "lucide-react";
import { ModuleTelegramCard } from "@/components/telegram/module-telegram-card";
import { getAllModules } from "@/lib/subdomain-app";
import { moduleIdForSettingsPath } from "@/lib/module-settings";

/**
 * Settings for one module (Sylo, Ryft, Fyra, Verve, Skarn, Warde, Wisp, Zynth).
 * One component serves every /<module>/settings route; the module comes from
 * the path, so it also works on the central domain, not only on module hosts.
 */
export default function ModuleSettings() {
  const [location] = useLocation();
  const moduleId = moduleIdForSettingsPath(location);
  const app = getAllModules().find((m) => m.id === moduleId);
  if (!moduleId || !app) return <div className="p-6 font-mono text-sm text-muted-foreground">Unknown module.</div>;

  return (
    <div className="max-w-2xl mx-auto p-4 md:p-6 space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
          <Settings className="w-4 h-4 text-primary" />
        </div>
        <div>
          <h1 className="font-mono font-bold text-lg text-foreground">{app.label} Settings</h1>
          <p className="font-mono text-xs text-muted-foreground">Connections and preferences for {app.label}.</p>
        </div>
      </div>
      <ModuleTelegramCard botKey={moduleId} label={app.label} />
    </div>
  );
}
