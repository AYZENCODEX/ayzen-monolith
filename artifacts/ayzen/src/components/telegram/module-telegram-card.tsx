import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ExternalLink, Link2, Loader2, Send, Unlink } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { getApiBase } from "@/lib/api-base";

interface BotLinkState {
  linked: boolean;
  active: boolean;
  username: string | null;
  verifiedAt: string | null;
  lastActivityAt: string | null;
  botUsername: string | null;
}

interface StartedLink { displayCode: string; deepLink: string | null; botUsername: string | null; expiresAt: number }

const EMPTY: BotLinkState = { linked: false, active: false, username: null, verifiedAt: null, lastActivityAt: null, botUsername: null };

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/**
 * Telegram bind / activate card for ONE module bot (botKey === module id).
 * Backed by /api/telegram/bots/:botKey/{me,link/start,link/verify,active,link}.
 */
export function ModuleTelegramCard({ botKey, label }: { botKey: string; label: string }) {
  const { token } = useAuth() as { token?: string };
  const { toast } = useToast();
  const [state, setState] = useState<BotLinkState>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [notConfigured, setNotConfigured] = useState(false);
  const [started, setStarted] = useState<StartedLink | null>(null);
  const [busy, setBusy] = useState<null | "start" | "verify" | "active" | "unlink">(null);
  const [code, setCode] = useState("");
  const alive = useRef(true);

  const call = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const res = await fetch(`${getApiBase()}/api/telegram/bots/${botKey}${path}`, {
        ...init,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      });
      const data = await res.json().catch(() => ({}));
      return { res, data };
    },
    [botKey, token],
  );

  const refresh = useCallback(async () => {
    try {
      const { res, data } = await call("/me");
      if (alive.current && res.ok) setState({ ...EMPTY, ...data });
    } catch { /* keep previous state */ }
    if (alive.current) setLoading(false);
  }, [call]);

  useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; }; }, [refresh]);

  // While a connect code is showing, watch for the bot to claim it.
  useEffect(() => {
    if (!started || state.linked) return;
    const timer = setInterval(() => {
      if (Date.now() > started.expiresAt) { setStarted(null); return; }
      void refresh();
    }, 3000);
    return () => clearInterval(timer);
  }, [started, state.linked, refresh]);

  useEffect(() => {
    if (state.linked && started) {
      setStarted(null);
      toast({ title: `${label} Telegram linked` });
    }
  }, [state.linked, started, label, toast]);

  const start = async () => {
    setBusy("start");
    setNotConfigured(false);
    try {
      const { res, data } = await call("/link/start", { method: "POST" });
      if (res.ok) setStarted({ displayCode: data.displayCode, deepLink: data.deepLink, botUsername: data.botUsername, expiresAt: new Date(data.expiresAt).getTime() });
      else if (data.code === "TELEGRAM_BOT_NOT_CONFIGURED") setNotConfigured(true);
      else toast({ variant: "destructive", title: "Could not start linking", description: data.error });
    } catch { toast({ variant: "destructive", title: "Connection error" }); }
    setBusy(null);
  };

  const verify = async () => {
    setBusy("verify");
    try {
      const { res, data } = await call("/link/verify", { method: "POST", body: JSON.stringify({ code }) });
      if (res.ok) { setCode(""); setStarted(null); setState((s) => ({ ...s, ...data, linked: true })); toast({ title: `${label} Telegram linked` }); }
      else toast({ variant: "destructive", title: "Link failed", description: data.error });
    } catch { toast({ variant: "destructive", title: "Connection error" }); }
    setBusy(null);
  };

  const toggleActive = async (active: boolean) => {
    const previous = state.active;
    setState((s) => ({ ...s, active }));
    setBusy("active");
    try {
      const { res, data } = await call("/active", { method: "PATCH", body: JSON.stringify({ active }) });
      if (!res.ok) { setState((s) => ({ ...s, active: previous })); toast({ variant: "destructive", title: "Could not update", description: data.error }); }
    } catch { setState((s) => ({ ...s, active: previous })); toast({ variant: "destructive", title: "Connection error" }); }
    setBusy(null);
  };

  const unlink = async () => {
    setBusy("unlink");
    try {
      const { res } = await call("/link", { method: "DELETE" });
      if (res.ok) { setState((s) => ({ ...EMPTY, botUsername: s.botUsername })); toast({ title: `${label} Telegram disconnected` }); }
    } catch { toast({ variant: "destructive", title: "Error disconnecting" }); }
    setBusy(null);
  };

  const botName = state.botUsername ?? started?.botUsername ?? null;

  return (
    <div className="bg-card border border-card-border rounded-lg overflow-hidden" data-testid={`telegram-card-${botKey}`}>
      <div className="bg-[#229ED9]/5 border-b border-card-border px-5 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[#229ED9]/10 border border-[#229ED9]/20 flex items-center justify-center">
            <Send className="w-4 h-4 text-[#229ED9]" />
          </div>
          <div>
            <div className="font-mono font-bold text-sm text-foreground">{label} Telegram Bot</div>
            <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
              {botName ? <a href={`https://t.me/${botName}`} target="_blank" rel="noopener noreferrer" className="text-[#229ED9] hover:underline inline-flex items-center gap-0.5">@{botName} <ExternalLink className="w-2.5 h-2.5" /></a> : "Commands & notifications"}
            </div>
          </div>
        </div>
        {loading ? <div className="w-16 h-5 bg-muted/30 rounded animate-pulse" />
          : state.linked ? (
            <Badge className={state.active ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20 font-mono text-[10px] uppercase tracking-wider" : "bg-amber-500/10 text-amber-400 border-amber-500/20 font-mono text-[10px] uppercase tracking-wider"}>
              {state.active ? "Active" : "Paused"}
            </Badge>
          ) : <Badge variant="outline" className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Not linked</Badge>}
      </div>

      <div className="px-5 py-5 space-y-5">
        {state.linked ? (
          <div className="space-y-4">
            <div className="bg-emerald-500/5 border border-emerald-500/15 rounded-md px-4 py-3 flex items-center gap-3">
              <CheckCircle2 className="w-5 h-5 text-emerald-400 flex-shrink-0" />
              <div>
                <div className="font-mono text-sm text-emerald-400 font-medium">Account connected</div>
                <div className="font-mono text-xs text-muted-foreground mt-0.5">
                  {state.username ? `@${state.username} · ` : ""}last activity {timeAgo(state.lastActivityAt)}
                </div>
              </div>
            </div>
            <label className="flex items-center justify-between gap-4 rounded-md border border-border px-4 py-3">
              <div>
                <div className="font-mono text-sm text-foreground">Bot active</div>
                <div className="font-mono text-[11px] text-muted-foreground">When off, the bot stays linked but ignores your commands.</div>
              </div>
              <Switch checked={state.active} onCheckedChange={toggleActive} disabled={busy === "active"} aria-label={`${label} bot active`} />
            </label>
            <Button variant="outline" size="sm" onClick={unlink} disabled={busy === "unlink"}
              className="font-mono text-xs border-red-500/20 text-red-400 hover:bg-red-500/10 hover:border-red-500/30 gap-2">
              <Unlink className="w-3.5 h-3.5" />{busy === "unlink" ? "Disconnecting..." : "Disconnect Telegram"}
            </Button>
          </div>
        ) : (
          <div className="space-y-5">
            {notConfigured && (
              <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-4 py-3 font-mono text-xs text-amber-400">
                The {label} bot is not configured yet. An admin needs to set its token.
              </div>
            )}
            {started ? (
              <div className="space-y-3">
                <p className="font-mono text-[11px] text-muted-foreground uppercase tracking-widest">Finish in Telegram</p>
                {started.deepLink && (
                  <Button asChild className="gap-2 font-mono text-xs">
                    <a href={started.deepLink} target="_blank" rel="noopener noreferrer"><Send className="w-3.5 h-3.5" />Open @{started.botUsername} and press Start</a>
                  </Button>
                )}
                <p className="font-mono text-xs text-muted-foreground">
                  Or send <span className="bg-muted px-1.5 py-0.5 rounded text-primary">/start {started.displayCode.replace("-", "")}</span> to the bot. Code expires in 10 minutes.
                </p>
                <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground"><Loader2 className="w-3.5 h-3.5 animate-spin" />Waiting for Telegram…</div>
              </div>
            ) : (
              <Button onClick={start} disabled={busy === "start" || loading} className="gap-2 font-mono text-xs">
                <Link2 className="w-3.5 h-3.5" />{busy === "start" ? "Starting..." : `Connect ${label} on Telegram`}
              </Button>
            )}

            <div className="space-y-2 border-t border-border pt-4">
              <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">I already have a code (send /connect to the bot)</label>
              <div className="flex gap-2">
                <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 9))}
                  placeholder="ABCD-EFGH" maxLength={9}
                  className="font-mono tracking-[0.25em] text-center text-lg h-11 bg-input border-border max-w-[200px]" />
                <Button variant="outline" onClick={verify} disabled={busy === "verify" || code.replace("-", "").length < 8} className="h-11 font-mono text-xs">
                  {busy === "verify" ? "Linking..." : "Link"}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
