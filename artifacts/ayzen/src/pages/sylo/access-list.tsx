/**
 * pages/sylo/access-list.tsx — /vault/access/:kind  (kind ∈ entity | local | kyc)
 *
 * Pick one account to open its mailbox, 2FA codes and backup codes together.
 * Selecting a row opens that account's own page (mobile-first: a new page,
 * never a pane or modal). The target pages already exist:
 *   entity → /vault/entity/:id/access   local → /vault/local/:id   kyc → /vault/kyc/:id
 */
import { useMemo, useState } from "react";
import { Link, Redirect, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { customFetch, useListVaultEntries } from "@workspace/api-client-react";
import { InlineError, EmptyState } from "@/components/console";

type Kind = "entity" | "local" | "kyc";
interface Item { id: number; mark: string; name: string; sub: string; href: string }

const TITLE: Record<Kind, string> = { entity: "Entities", local: "Local accounts", kyc: "KYC accounts" };
const LABEL: Record<Kind, string> = { entity: "Entity", local: "Local accounts", kyc: "KYC" };
const initials = (s: string) => (s.trim().slice(0, 2) || "··").toUpperCase();

function useItems(kind: Kind) {
  const entities = useListVaultEntries({ query: { enabled: kind === "entity" } } as never);
  const local = useQuery({
    queryKey: ["access-list", "local"], enabled: kind === "local",
    queryFn: () => customFetch<any[]>("/api/local-accounts"),
  });
  const kyc = useQuery({
    queryKey: ["access-list", "kyc"], enabled: kind === "kyc",
    queryFn: () => customFetch<any[]>("/api/kyc-entries"),
  });

  return useMemo(() => {
    if (kind === "entity") {
      const rows = ((entities.data as any[] | undefined) ?? []).map((e): Item => ({
        id: e.id, mark: initials(e.projectName ?? "E"), name: e.projectName ?? `Entity #${e.id}`,
        sub: e.entitySerial ?? "Entity", href: `/vault/entity/${e.id}/access`,
      }));
      return { rows, isPending: entities.isPending, error: entities.error, refetch: entities.refetch };
    }
    if (kind === "local") {
      const rows = (local.data ?? []).map((a): Item => {
        const name = a.label || a.username || a.email || `Account #${a.id}`;
        return { id: a.id, mark: initials(name), name, sub: a.category ?? "Local", href: `/vault/local/${a.id}` };
      });
      return { rows, isPending: local.isPending, error: local.error, refetch: local.refetch };
    }
    const rows = (kyc.data ?? []).map((k): Item => {
      const name = k.username || k.email || `Entry #${k.id}`;
      return { id: k.id, mark: initials(name), name, sub: k.category ?? "KYC", href: `/vault/kyc/${k.id}` };
    });
    return { rows, isPending: kyc.isPending, error: kyc.error, refetch: kyc.refetch };
  }, [kind, entities.data, entities.isPending, entities.error, local.data, local.isPending, local.error, kyc.data, kyc.isPending, kyc.error]);
}

export default function SyloAccessList() {
  const { kind } = useParams<{ kind: string }>();
  const k = (["entity", "local", "kyc"] as const).find((x) => x === kind);
  if (!k) return <Redirect to="/vault/access/entity" />;
  return <List kind={k} />;
}

function List({ kind }: { kind: Kind }) {
  const [q, setQ] = useState("");
  const { rows, isPending, error, refetch } = useItems(kind);
  const shown = rows.filter((r) => !q || `${r.name} ${r.sub}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="stack">
      <div className="ph">
        <div>
          <div className="eb">Access · {LABEL[kind]}</div>
          <h1>{TITLE[kind]}</h1>
          <p>Choose one to open its mailbox, authenticator codes and backup codes.</p>
        </div>
      </div>
      <div className="card">
        <div className="tool">
          <label className="in" style={{ flex: 1 }}>
            <Search size={14} aria-hidden="true" />
            <input
              value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an account…" aria-label="Find an account"
              style={{ background: "transparent", border: 0, outline: 0, color: "inherit", font: "inherit", width: "100%" }}
            />
          </label>
        </div>
        {isPending && <div className="row" style={{ padding: "14px 18px" }}><div className="g"><b>Loading…</b></div></div>}
        {!isPending && error ? <InlineError error={error} onRetry={() => void refetch()} /> : null}
        {!isPending && !error && shown.length === 0 && (
          <EmptyState icon={Search} title={q ? "No matches" : "Nothing here yet"} description={q ? "Try a different search." : "Add an account first, then it will show up here."} />
        )}
        {shown.map((r) => (
          <Link key={r.id} href={r.href} className="row go" style={{ padding: "14px 18px" }}>
            <span className="mk">{r.mark}</span>
            <div className="g"><b>{r.name}</b><span>{r.sub}</span></div>
          </Link>
        ))}
      </div>
    </div>
  );
}
