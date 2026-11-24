/**
 * vault-activity.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Vault → Other → Activity Log.
 *
 * Shows the current user's own Vault activity feed only — "at this time,
 * this happened, on this entity/page" — sourced from GET /vault/activity
 * (vault_activity_log rows scoped to this user). Distinct from the
 * platform-wide Activity Log at /admin/activity (all users, all actions)
 * and from an entity's own timeline at /vault/entity/:id (one entity only).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { History, Eye, PlusCircle, Pencil, Trash2, KeyRound, Wallet, RefreshCw, ChevronRight, ChevronLeft } from "lucide-react";
import { Link } from "wouter";
import { InlineError } from "@/components/console";
import { getVaultActivity, type VaultActivityEntry } from "@/lib/vault-security-api";

const ACTION_META: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  viewed:          { label: "Viewed",          icon: Eye,        color: "text-primary bg-primary/10 border-primary/20" },
  created:         { label: "Created",         icon: PlusCircle, color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20" },
  updated:         { label: "Updated",         icon: Pencil,     color: "text-blue-400 bg-blue-500/10 border-blue-500/20" },
  deleted:         { label: "Deleted",         icon: Trash2,     color: "text-red-400 bg-red-500/10 border-red-500/20" },
  status_changed:  { label: "Status changed",  icon: RefreshCw,  color: "text-amber-400 bg-amber-500/10 border-amber-500/20" },
  seed_revealed:   { label: "Seed revealed",   icon: KeyRound,   color: "text-violet-400 bg-violet-500/10 border-violet-500/20" },
  drive_wallet_set:{ label: "Drive wallet set",icon: Wallet,     color: "text-cyan-400 bg-cyan-500/10 border-cyan-500/20" },
};

function metaFor(action: string) {
  return ACTION_META[action] ?? { label: action.replace(/_/g, " "), icon: History, color: "text-muted-foreground bg-muted/20 border-border/40" };
}

function formatWhen(iso: string): { date: string; time: string; relative: string } {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const s = Math.floor(diff / 1000);
  let relative: string;
  if (s < 60) relative = `${s}s ago`;
  else if (s < 3600) relative = `${Math.floor(s / 60)}m ago`;
  else if (s < 86400) relative = `${Math.floor(s / 3600)}h ago`;
  else relative = `${Math.floor(s / 86400)}d ago`;
  return {
    date: d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }),
    time: d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
    relative,
  };
}

export default function VaultActivity() {
  const [page, setPage] = useState(1);
  const limit = 30;

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["vault-activity", page],
    queryFn: () => getVaultActivity(page, limit),
  });

  const entries = data?.entries ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="stack t-brass">
      <div className="ph">
        <div>
          <div className="eb">Records · Activity</div>
          <h1>Activity log</h1>
          <p>Everything you've done inside Sylo — what happened, when, and where.</p>
        </div>
        <div className="acts">
          <button type="button" className="btn" onClick={() => void refetch()} disabled={isFetching}>{isFetching ? "Refreshing…" : "Refresh"}</button>
        </div>
      </div>
      <div className="card">
        {isLoading && <div className="row" style={{ padding: "14px 18px" }} role="status"><div className="g"><b>Loading…</b></div></div>}
        {!isLoading && error ? <InlineError error={error} onRetry={() => void refetch()} /> : null}
        {!isLoading && !error && entries.length === 0 && (
          <div className="row" style={{ padding: "26px 18px", flexDirection: "column", alignItems: "flex-start", gap: 6 }}>
            <b style={{ fontWeight: 500 }}>No activity yet</b>
            <span style={{ fontFamily: "var(--sans)" }}>Viewing, creating or editing an entity shows up here with the exact time.</span>
          </div>
        )}
        {entries.map((entry) => {
          const meta = metaFor(entry.action);
          const { date, time, relative } = formatWhen(entry.createdAt);
          const label = entry.entitySerial ?? (entry.entityId ? `Entity #${entry.entityId}` : "Vault");
          const body = (
            <>
              <span className="mk">{meta.label.slice(0, 2).toUpperCase()}</span>
              <div className="g">
                <b>{label}</b>
                <span>{entry.detail ? `${entry.detail} · ` : ""}{date} · {time} ({relative})</span>
              </div>
              <span className="pill">{meta.label}</span>
            </>
          );
          return entry.entityId
            ? <Link key={entry.id} href={`/vault/entity/${entry.entityId}`} className="row go" style={{ padding: "14px 18px" }}>{body}</Link>
            : <div key={entry.id} className="row" style={{ padding: "14px 18px" }}>{body}</div>;
        })}
        {totalPages > 1 && (
          <div className="tool" style={{ borderBottom: 0, borderTop: "1px solid var(--line)" }}>
            <span className="mono" style={{ color: "var(--di)", fontSize: 11, flex: 1 }}>Page {page} of {totalPages} · {total.toLocaleString()} events</span>
            <button type="button" className="btn sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</button>
            <button type="button" className="btn sm" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Next</button>
          </div>
        )}
      </div>
    </div>
  );
}
