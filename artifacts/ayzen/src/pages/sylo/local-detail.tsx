/** pages/sylo/local-detail.tsx — /vault/local/:id (full tooling lives at /vault/local/:id/manage) */
import { useParams, useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch, ApiError } from "@workspace/api-client-react";
import { NotFoundPage, InlineError } from "@/components/console";
import type { LocalAccount } from "@/components/local-accounts";
import { accountPath } from "@/lib/sylo-routes";
import { Back, Card } from "./credit-ui";
import { EntryDetail, day, money, roi } from "./entry-detail";

interface Point { id: number; amount: number; notes: string | null; created_at: string }

export default function SyloLocalDetail() {
  const { id = "" } = useParams<{ id: string }>();
  const [, go] = useLocation();
  const qc = useQueryClient();
  const back = accountPath("local", "management");
  const q = useQuery({
    queryKey: ["sylo", "local", id],
    queryFn: () => customFetch<LocalAccount>(`/api/local-accounts/${encodeURIComponent(id)}`),
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2,
  });
  const pts = useQuery({
    queryKey: ["sylo", "local", id, "points"],
    queryFn: () => customFetch<{ entries: Point[]; total: number }>(`/api/local-accounts/${encodeURIComponent(id)}/points`),
    enabled: !!q.data,
  });
  const del = useMutation({
    mutationFn: () => customFetch(`/api/local-accounts/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["sylo", "local"] }); go(back); },
  });

  if (q.error instanceof ApiError && q.error.status === 404) return <NotFoundPage embedded />;
  if (q.isPending) return <div className="stack" role="status"><Back href={back} label="Local accounts" /><div className="card"><div className="body">Loading…</div></div></div>;
  if (q.error || !q.data) return <div className="stack"><Back href={back} label="Local accounts" /><InlineError error={q.error} onRetry={() => void q.refetch()} /></div>;

  const a = q.data;
  const name = a.label || a.username || a.email || `Account #${a.id}`;
  const entries = pts.data?.entries ?? [];
  return (
    <EntryDetail
      backHref={back} backLabel="Local accounts" eyebrow={`Local · ${a.category}`} title={name}
      sub={[a.username && `@${a.username}`, a.score !== null && a.score !== undefined ? `Score ${a.score}` : null].filter(Boolean).join(" · ") || undefined}
      badge={a.twofa ? <span className="pill ok">2FA set</span> : <span className="pill warn">No 2FA</span>}
      manageHref={`/vault/local/${a.id}/manage`}
      kpis={[
        ["Worth", money(a.account_worth) ?? "—", roi(a.account_worth, a.buy_price) ? `ROI ${roi(a.account_worth, a.buy_price)}` : undefined],
        ["Buy price", money(a.buy_price) ?? "—"],
        ["Followers", a.followers ?? "—"],
        ["Last login", day(a.account_last_login_date) ?? "—"],
      ]}
      sections={[
        { title: "Credentials", rows: [
          { label: "Username", value: a.username }, { label: "Email", value: a.email },
          { label: "Password", value: a.password, secret: true },
          { label: "Recovery email", value: a.recovery_email },
          { label: "Recovery pass", value: a.recovery_email_password, secret: true },
          { label: "2FA", value: a.twofa, secret: true },
          { label: "Recovery 2FA", value: a.recovery_email_twofa, secret: true },
          { label: "Backups", value: a.backup_codes, secret: true },
        ] },
        { title: "Dates", rows: [
          { label: "Created", value: day(a.account_create_date) }, { label: "Bought", value: day(a.account_buy_date) },
          { label: "Last login", value: day(a.account_last_login_date) },
        ] },
        { title: "Notes", rows: [{ label: "Notes", value: a.notes }] },
      ]}
      extra={entries.length > 0 ? (
        <Card title="Points" note="log" flush>
          {entries.map((p) => (
            <div className="row" key={p.id} style={{ padding: "14px 18px" }}>
              <div className="g"><b>{p.amount >= 0 ? "+" : ""}{p.amount}</b><span>{p.notes ?? "added"}</span></div>
              <span className="mono" style={{ color: "var(--di)", fontSize: 11 }}>{day(p.created_at)}</span>
            </div>
          ))}
        </Card>
      ) : null}
      onDelete={() => del.mutate()} deleting={del.isPending}
      deleteError={del.error ? "Couldn’t delete this account. Try again." : null}
    />
  );
}
