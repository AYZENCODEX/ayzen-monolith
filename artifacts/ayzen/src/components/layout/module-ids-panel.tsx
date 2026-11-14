import { useModuleAccounts } from "@/lib/module-accounts-api";

/** W1-P1: the user's id in every module that has one, for the profile page. Hidden when none exist. */
export function ModuleIdsPanel() {
  const { data } = useModuleAccounts();
  const rows = (data ?? []).filter((m) => m.moduleUid);
  if (rows.length === 0) return null;
  return (
    <div className="rounded-xl border border-border bg-card/50 p-4" data-testid="module-ids-panel">
      <div className="mb-3 text-[10px] font-mono tracking-widest text-muted-foreground">MODULE IDS</div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {rows.map((m) => (
          <div key={m.module} className="flex items-center justify-between rounded-lg bg-muted/30 px-3 py-2 font-mono text-xs">
            <span className="text-muted-foreground">{m.label}</span>
            <span className="tracking-wider text-foreground">{m.moduleUid}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
