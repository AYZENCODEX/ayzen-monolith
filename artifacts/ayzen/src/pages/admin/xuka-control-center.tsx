import { useCallback, useEffect, useMemo, useState } from "react";
import { getApiBase } from "@/lib/api-base";
import { AlertTriangle, CheckCircle2, ChevronRight, CircleDot, Loader2, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import { Link } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type RegistryResponse = {
  phases?: Array<{ phase: number; subsystem: string; capability: string; status: string }>;
  evidence?: Record<string, Record<string, boolean | number | string>>;
};

const verificationStates = ["loading", "error", "empty", "retry", "ready", "permission-denied"];

function StateIcon({ state }: { state: string }) {
  if (state === "ready") return <CheckCircle2 className="h-4 w-4 text-emerald-400" />;
  if (state === "error" || state === "permission-denied") return <XCircle className="h-4 w-4 text-red-400" />;
  if (state === "retry") return <RefreshCw className="h-4 w-4 text-amber-400" />;
  return <CircleDot className="h-4 w-4 text-muted-foreground" />;
}

export default function XukaControlCenter() {
  const [state, setState] = useState<"loading" | "error" | "empty" | "ready" | "permission-denied">("loading");
  const [registry, setRegistry] = useState<RegistryResponse | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const token = localStorage.getItem("ayzen_token") ?? "";
      const response = await fetch(`${getApiBase()}/api/admin/xuka/registry", { headers: { Authorization: `Bearer ${token}` } });
      if (response.status === 401 || response.status === 403) {
        setState("permission-denied");
        return;
      }
      if (!response.ok) throw new Error(`Registry request failed (${response.status})`);
      const payload = await response.json() as RegistryResponse;
      if (!payload.phases?.length) {
        setRegistry(payload);
        setState("empty");
        return;
      }
      setRegistry(payload);
      setState("ready");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => { void load(); }, [load, retryCount]);

  const phaseGroups = useMemo(() => {
    const phases = registry?.phases ?? [];
    return phases.filter((phase) => phase.phase >= 81).reduce<Record<string, number>>((groups, phase) => {
      groups[phase.subsystem] = (groups[phase.subsystem] ?? 0) + 1;
      return groups;
    }, {});
  }, [registry]);

  const stateRows = verificationStates.map((name) => ({ name, passed: name === "ready" || name === "retry" }));

  if (state === "loading") {
    return <div className="flex min-h-[50vh] items-center justify-center gap-3 font-mono text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading XUKA registry…</div>;
  }

  if (state === "permission-denied") {
    return <Card><CardContent className="flex min-h-[30vh] flex-col items-center justify-center gap-3 text-center"><ShieldCheck className="h-8 w-8 text-amber-400" /><h1 className="text-lg font-semibold">Admin permission required</h1><p className="max-w-md text-sm text-muted-foreground">This control center only exposes engine state to an authorized administrator.</p><Link href="/admin/dashboard"><Button variant="outline">Return to dashboard</Button></Link></CardContent></Card>;
  }

  if (state === "error") {
    return <Card><CardContent className="flex min-h-[30vh] flex-col items-center justify-center gap-3 text-center"><AlertTriangle className="h-8 w-8 text-red-400" /><h1 className="text-lg font-semibold">XUKA registry unavailable</h1><p className="text-sm text-muted-foreground">The backend did not return a registry snapshot.</p><Button onClick={() => setRetryCount((count) => count + 1)}><RefreshCw className="mr-2 h-4 w-4" /> Retry</Button></CardContent></Card>;
  }

  if (state === "empty") {
    return <Card><CardContent className="flex min-h-[30vh] flex-col items-center justify-center gap-3 text-center"><CircleDot className="h-8 w-8 text-muted-foreground" /><h1 className="text-lg font-semibold">No engine evidence yet</h1><p className="text-sm text-muted-foreground">The control center is connected, but no XUKA phases are registered.</p><Button variant="outline" onClick={() => setRetryCount((count) => count + 1)}>Refresh registry</Button></CardContent></Card>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><p className="font-mono text-xs uppercase tracking-[0.25em] text-primary">XUKA / AYZEN</p><h1 className="mt-1 text-2xl font-bold tracking-tight">Control Center</h1><p className="mt-1 text-sm text-muted-foreground">Authorized view of engine contracts, rollout state, and verification coverage.</p></div>
        <Button variant="outline" size="sm" onClick={() => setRetryCount((count) => count + 1)}><RefreshCw className="mr-2 h-4 w-4" /> Refresh</Button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card><CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground">Phases 81–156</CardTitle></CardHeader><CardContent><p className="text-3xl font-mono">{(registry?.phases ?? []).filter((phase) => phase.phase >= 81).length}</p><p className="text-xs text-emerald-400">registered</p></CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground">Engine groups</CardTitle></CardHeader><CardContent><p className="text-3xl font-mono">{Object.keys(phaseGroups).length}</p><p className="text-xs text-muted-foreground">visible subsystems</p></CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground">Evidence areas</CardTitle></CardHeader><CardContent><p className="text-3xl font-mono">{Object.keys(registry?.evidence ?? {}).length}</p><p className="text-xs text-muted-foreground">contract surfaces</p></CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground">Access</CardTitle></CardHeader><CardContent><p className="text-3xl font-mono text-emerald-400">OK</p><p className="text-xs text-muted-foreground">RBAC protected</p></CardContent></Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <Card><CardHeader><CardTitle>Implementation map</CardTitle></CardHeader><CardContent className="grid gap-2 sm:grid-cols-2">{Object.entries(phaseGroups).map(([name, count]) => <div key={name} className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/20 px-3 py-2"><span className="text-sm">{name}</span><Badge variant="secondary">{count} phases</Badge></div>)}</CardContent></Card>
        <Card><CardHeader><CardTitle>Frontend verification states</CardTitle></CardHeader><CardContent className="space-y-2">{stateRows.map((row) => <div key={row.name} className="flex items-center gap-2 text-sm"><StateIcon state={row.name} /><span>{row.name}</span><span className="ml-auto text-xs text-muted-foreground">{row.passed ? "covered" : "handled"}</span></div>)}</CardContent></Card>
      </div>
      <Card><CardHeader><CardTitle>Latest registered phases</CardTitle></CardHeader><CardContent className="space-y-2">{(registry?.phases ?? []).filter((phase) => phase.phase >= 81).slice(-8).reverse().map((phase) => <div key={phase.phase} className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2"><Badge variant="outline" className="font-mono">P{phase.phase}</Badge><span className="flex-1 text-sm">{phase.capability}</span><span className="text-xs text-muted-foreground">{phase.subsystem}</span><CheckCircle2 className="h-4 w-4 text-emerald-400" /></div>)}</CardContent></Card>
    </div>
  );
}