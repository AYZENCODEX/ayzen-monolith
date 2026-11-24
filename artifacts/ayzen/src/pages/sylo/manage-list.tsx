/**
 * pages/sylo/manage-list.tsx — Management view for Entity / Local / KYC / Game.
 * One Sylo-style list: search, category filter, rows open the entry's own page,
 * Add opens the create page. The previous manager (bulk share, selection,
 * category editing) stays one click away via ?legacy=1.
 */
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { customFetch } from "@workspace/api-client-react";
import { InlineError, EmptyState } from "@/components/console";
import type { AccountSection } from "@/lib/sylo-routes";

interface Row { id: number; name: string; sub: string; cat: string; tag?: string; href: string }
interface Cfg { url: string; label: string; href: (id: number) => string; map: (r: any) => Omit<Row, "href"> }

const CFG: Record<AccountSection, Cfg> = {
  entity: {
    url: "/api/vault", label: "entity", href: (id) => `/vault/entity/${id}`,
    map: (e) => ({ id: e.id, name: e.projectName || `Entity #${e.id}`, sub: e.entitySerial || "Entity", cat: e.status && e.status !== "active" ? e.status : "active", tag: e.status && e.status !== "active" ? e.status : undefined }),
  },
  local: {
    url: "/api/local-accounts", label: "account", href: (id) => `/vault/local/${id}`,
    map: (a) => ({ id: a.id, name: a.label || a.username || a.email || `Account #${a.id}`, sub: a.email || a.username || "—", cat: a.category ?? "Other", tag: a.twofa ? undefined : "No 2FA" }),
  },
  kyc: {
    url: "/api/kyc-entries", label: "entry", href: (id) => `/vault/kyc/${id}`,
    map: (k) => ({ id: k.id, name: k.name || k.username || k.email || `Entry #${k.id}`, sub: k.email || k.platform || "—", cat: k.category ?? "Other" }),
  },
  game: {
    url: "/api/game-entries", label: "game account", href: (id) => `/vault/game/${id}`,
    map: (g) => ({ id: g.id, name: g.username || `Entry #${g.id}`, sub: [g.rank, g.level && `Lv ${g.level}`].filter(Boolean).join(" · ") || g.email || "—", cat: g.category ?? "Other" }),
  },
};

const mark = (s: string) => (s.trim().slice(0, 2) || "··").toUpperCase();

export function ManageList({ section }: { section: AccountSection }) {
  const cfg = CFG[section];
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("all");
  const query = useQuery({ queryKey: ["sylo", "manage", section], queryFn: () => customFetch<any[]>(cfg.url) });

  const rows = useMemo<Row[]>(
    () => (Array.isArray(query.data) ? query.data : []).map((r) => { const m = cfg.map(r); return { ...m, href: cfg.href(m.id) }; }),
    [query.data, cfg],
  );
  const cats = useMemo(() => Array.from(new Set(rows.map((r) => r.cat))).sort(), [rows]);
  const needle = q.trim().toLowerCase();
  const shown = rows.filter((r) => (cat === "all" || r.cat === cat) && (!needle || `${r.name} ${r.sub} ${r.cat}`.toLowerCase().includes(needle)));

  return (
    <div className="card">
      <div className="tool">
        <label className="in" style={{ flex: 1 }}>
          <Search size={14} aria-hidden="true" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Find ${cfg.label}…`} aria-label={`Find ${cfg.label}`} />
        </label>
        {cats.length > 1 && (
          <label className="in" style={{ maxWidth: 170 }}>
            <select value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Category">
              <option value="all">All categories</option>
              {cats.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        )}
        <Link href="?legacy=1" className="btn sm" title="Bulk share, selection and category tools">Bulk tools</Link>
      </div>
      {query.isPending && <div className="row" style={{ padding: "14px 18px" }} role="status"><div className="g"><b>Loading…</b></div></div>}
      {!query.isPending && query.error ? <InlineError error={query.error} onRetry={() => void query.refetch()} /> : null}
      {!query.isPending && !query.error && shown.length === 0 && (
        <EmptyState icon={Search} title={needle || cat !== "all" ? "No matches" : "Nothing here yet"}
          description={needle || cat !== "all" ? "Try a different search or category." : `Add your first ${cfg.label} to see it here.`} />
      )}
      {shown.map((r) => (
        <Link key={r.id} href={r.href} className="row go" style={{ padding: "14px 18px" }}>
          <span className="mk">{mark(r.name)}</span>
          <div className="g"><b>{r.name}</b><span>{r.sub}</span></div>
          {r.tag && <span className="pill warn">{r.tag}</span>}
          <span className="pill">{r.cat}</span>
        </Link>
      ))}
    </div>
  );
}
