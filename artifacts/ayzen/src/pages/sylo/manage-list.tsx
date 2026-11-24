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
import { useToast } from "@/hooks/use-toast";
import type { AccountSection } from "@/lib/sylo-routes";
import { ShareEntityDialog, type ShareTarget } from "@/components/vault/share-entity-dialog";
import { ManageSharesDialog } from "@/components/vault/manage-shares-dialog";
import { AccountFormDialog, AddCategoryDialog, type Category } from "@/components/local-accounts";
import { LOCAL_ACCOUNT_DEFAULT_CATEGORIES } from "@/config/vault-local";
import { KycDialog } from "@/components/kyc-entries";
import { GameDialog } from "@/components/game-entries";

interface Row { id: number; name: string; sub: string; cat: string; tag?: string; href: string; raw?: any; banned?: boolean }
interface Cfg {
  url: string; label: string; del: (id: number) => string; status?: (id: number) => string;
  href: (id: number) => string; map: (r: any) => Omit<Row, "href" | "raw">;
}

const CFG: Record<AccountSection, Cfg> = {
  entity: {
    url: "/api/vault", label: "entity", del: (id) => `/api/vault/${id}`, href: (id) => `/vault/entity/${id}`,
    map: (e) => ({ id: e.id, name: e.projectName || `Entity #${e.id}`, sub: e.entitySerial || "Entity", cat: e.status && e.status !== "active" ? e.status : "active", tag: e.status && e.status !== "active" ? e.status : undefined }),
  },
  local: {
    url: "/api/local-accounts", label: "account", del: (id) => `/api/local-accounts/${id}`, status: (id) => `/api/local-accounts/${id}/status`, href: (id) => `/vault/local/${id}`,
    map: (a) => ({ id: a.id, name: a.label || a.username || a.email || `Account #${a.id}`, sub: a.email || a.username || "—", cat: a.category ?? "Other", tag: a.status === "banned" ? "Banned" : a.twofa ? undefined : "No 2FA", banned: a.status === "banned" }),
  },
  kyc: {
    url: "/api/kyc-entries", label: "entry", del: (id) => `/api/kyc-entries/${id}`, status: (id) => `/api/kyc-entries/${id}/status`, href: (id) => `/vault/kyc/${id}`,
    map: (k) => ({ id: k.id, name: k.name || k.username || k.email || `Entry #${k.id}`, sub: k.email || k.platform || "—", cat: k.category ?? "Other", tag: k.status === "banned" ? "Banned" : undefined, banned: k.status === "banned" }),
  },
  game: {
    url: "/api/game-entries", label: "game account", del: (id) => `/api/game-entries/${id}`, href: (id) => `/vault/game/${id}`,
    map: (g) => ({ id: g.id, name: g.username || `Entry #${g.id}`, sub: [g.rank, g.level && `Lv ${g.level}`].filter(Boolean).join(" · ") || g.email || "—", cat: g.category ?? "Other" }),
  },
};

const mark = (s: string) => (s.trim().slice(0, 2) || "··").toUpperCase();

export function ManageList({ section }: { section: AccountSection }) {
  const cfg = CFG[section];
  const { toast } = useToast();
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("all");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState<number | null>(null);
  const [confirmDel, setConfirmDel] = useState<number | null>(null);
  const [share, setShare] = useState<{ items: ShareTarget[]; label?: string } | null>(null);
  const [managing, setManaging] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [addCat, setAddCat] = useState(false);
  const query = useQuery({ queryKey: ["sylo", "manage", section], queryFn: () => customFetch<any[]>(cfg.url) });
  const cats = useQuery({
    queryKey: ["sylo", "manage", "local-cats"], enabled: section === "local",
    queryFn: () => customFetch<{ custom: { id: number; name: string }[] }>("/api/local-accounts/categories"),
  });
  const refresh = () => { void query.refetch(); void cats.refetch?.(); };

  const rows = useMemo<Row[]>(
    () => (Array.isArray(query.data) ? query.data : []).map((r) => { const m = cfg.map(r); return { ...m, href: cfg.href(m.id), raw: r }; }),
    [query.data, cfg],
  );
  const customCats = cats.data?.custom ?? [];
  const catList = useMemo(() => {
    const set = new Set(rows.map((r) => r.cat));
    if (section === "local") { LOCAL_ACCOUNT_DEFAULT_CATEGORIES.forEach((c) => set.add(c.name)); customCats.forEach((c) => set.add(c.name)); }
    return Array.from(set).sort();
  }, [rows, section, customCats]);
  const needle = q.trim().toLowerCase();
  const shown = rows.filter((r) => (cat === "all" || r.cat === cat) && (!needle || `${r.name} ${r.sub} ${r.cat}`.toLowerCase().includes(needle)));
  const customSel = customCats.find((c) => c.name === cat);

  const toggle = (id: number) => setPicked((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const shareTargets = (ids: number[]): ShareTarget[] => ids.map((id) => ({ entityType: section, entityId: id }));

  async function remove(id: number) {
    try { await customFetch(cfg.del(id), { method: "DELETE" }); toast({ title: "Deleted" }); setConfirmDel(null); setOpen(null); refresh(); }
    catch { toast({ variant: "destructive", title: "Delete failed" }); }
  }
  async function ban(r: Row) {
    if (!cfg.status) return;
    const next = r.banned ? "active" : "banned";
    try { await customFetch(cfg.status(r.id), { method: "PATCH", body: JSON.stringify({ status: next }) }); toast({ title: next === "banned" ? "Banned — now under Banned" : "Unbanned" }); refresh(); }
    catch { toast({ variant: "destructive", title: "Couldn’t update ban status" }); }
  }
  async function removeCategory() {
    if (!customSel) return;
    try { await customFetch(`/api/local-accounts/categories/${customSel.id}`, { method: "DELETE" }); toast({ title: `“${customSel.name}” removed` }); setCat("all"); refresh(); }
    catch { toast({ variant: "destructive", title: "Failed to delete category" }); }
  }

  return (
    <div className="card">
      <div className="tool" style={{ flexWrap: "wrap" }}>
        <label className="in" style={{ flex: 1, minWidth: 180 }}>
          <Search size={14} aria-hidden="true" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Find ${cfg.label}…`} aria-label={`Find ${cfg.label}`} />
        </label>
        {catList.length > 1 && (
          <label className="in" style={{ maxWidth: 170 }}>
            <select value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Category">
              <option value="all">All categories</option>
              {catList.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        )}
        {section === "local" && <button type="button" className="btn sm" onClick={() => setAddCat(true)}>+ Category</button>}
        {customSel && <button type="button" className="btn sm" onClick={() => void removeCategory()}>Remove “{customSel.name}”</button>}
        <button type="button" className="btn sm" onClick={() => setManaging(true)}>Manage shares</button>
        <Link href="?legacy=1" className="btn sm g" title="Previous manager: bulk tag/status, import and more">Advanced</Link>
      </div>
      {picked.size > 0 && (
        <div className="tool">
          <span className="mono" style={{ flex: 1, color: "var(--mu)", fontSize: 12 }}>{picked.size} selected</span>
          <button type="button" className="btn sm p" onClick={() => setShare({ items: shareTargets(Array.from(picked)) })}>Share selected</button>
          <button type="button" className="btn sm g" onClick={() => setPicked(new Set())}>Clear</button>
        </div>
      )}
      {query.isPending && <div className="row" style={{ padding: "14px 18px" }} role="status"><div className="g"><b>Loading…</b></div></div>}
      {!query.isPending && query.error ? <InlineError error={query.error} onRetry={() => void query.refetch()} /> : null}
      {!query.isPending && !query.error && shown.length === 0 && (
        <EmptyState icon={Search} title={needle || cat !== "all" ? "No matches" : "Nothing here yet"}
          description={needle || cat !== "all" ? "Try a different search or category." : `Add your first ${cfg.label} to see it here.`} />
      )}
      {shown.map((r) => (
        <div key={r.id} style={{ borderBottom: "1px solid var(--line)" }}>
          <div className="row" style={{ padding: "12px 18px", borderBottom: 0, gap: 12 }}>
            <input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Select ${r.name}`} />
            <Link href={r.href} className="row go" style={{ padding: 0, border: 0, flex: 1, minWidth: 0 }}>
              <span className="mk">{mark(r.name)}</span>
              <div className="g"><b>{r.name}</b><span>{r.sub}</span></div>
              {r.tag && <span className="pill warn">{r.tag}</span>}
              <span className="pill">{r.cat}</span>
            </Link>
            <button type="button" className="btn sm g" aria-expanded={open === r.id} aria-label={`Actions for ${r.name}`}
              onClick={() => { setOpen(open === r.id ? null : r.id); setConfirmDel(null); }}>⋯</button>
          </div>
          {open === r.id && (
            <div className="tool" style={{ borderBottom: 0, paddingTop: 0, flexWrap: "wrap" }}>
              {section === "entity"
                ? <Link href={`/vault/entity/${r.id}/manage`} className="btn sm">Edit</Link>
                : <button type="button" className="btn sm" onClick={() => setEditing(r.raw)}>Edit</button>}
              <button type="button" className="btn sm" onClick={() => setShare({ items: shareTargets([r.id]), label: r.name })}>Share</button>
              {cfg.status && <button type="button" className="btn sm" onClick={() => void ban(r)}>{r.banned ? "Unban" : "Ban"}</button>}
              <button type="button" className="btn sm" onClick={() => (confirmDel === r.id ? void remove(r.id) : setConfirmDel(r.id))}>
                {confirmDel === r.id ? "Confirm delete" : "Delete"}
              </button>
            </div>
          )}
        </div>
      ))}

      <ShareEntityDialog open={share !== null} onClose={() => setShare(null)} items={share?.items ?? []} entityLabel={share?.label} onShared={() => setPicked(new Set())} />
      <ManageSharesDialog open={managing} onClose={() => setManaging(false)} entityType={section} />
      {section === "local" && (
        <>
          <AccountFormDialog open={editing !== null} onClose={() => setEditing(null)} editAccount={editing ?? undefined}
            selectedCategory={editing?.category ?? LOCAL_ACCOUNT_DEFAULT_CATEGORIES[0].name}
            allCategories={[...LOCAL_ACCOUNT_DEFAULT_CATEGORIES, ...customCats.map((c): Category => ({ id: c.id, name: c.name, color: "#8b5cf6", icon: c.name[0], isCustom: true }))]}
            onSaved={refresh} />
          <AddCategoryDialog open={addCat} onClose={() => setAddCat(false)} onAdded={refresh} />
        </>
      )}
      {section === "kyc" && <KycDialog open={editing !== null} editEntry={editing} onClose={() => setEditing(null)} onSaved={refresh} />}
      {section === "game" && <GameDialog open={editing !== null} editEntry={editing} onClose={() => setEditing(null)} onSaved={refresh} />}
    </div>
  );
}
