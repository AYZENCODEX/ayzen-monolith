/** pages/sylo/game-detail.tsx — /vault/game/:id (full page; edit from the list's ⋯ menu) */
import { useParams, useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch, ApiError } from "@workspace/api-client-react";
import { NotFoundPage, InlineError } from "@/components/console";
import type { GameEntry } from "@/components/game-entries";
import { accountPath } from "@/lib/sylo-routes";
import { Back } from "./credit-ui";
import { EntryDetail, day } from "./entry-detail";

export default function SyloGameDetail() {
  const { id = "" } = useParams<{ id: string }>();
  const [, go] = useLocation();
  const qc = useQueryClient();
  const back = accountPath("game", "management");
  const q = useQuery({
    queryKey: ["sylo", "game", id],
    queryFn: () => customFetch<GameEntry>(`/api/game-entries/${encodeURIComponent(id)}`),
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2,
  });
  const del = useMutation({
    mutationFn: () => customFetch(`/api/game-entries/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["sylo"] }); go(back); },
  });

  if (q.error instanceof ApiError && q.error.status === 404) return <NotFoundPage embedded />;
  if (q.isPending) return <div className="stack" role="status"><Back href={back} label="Game accounts" /><div className="card"><div className="body">Loading…</div></div></div>;
  if (q.error || !q.data) return <div className="stack"><Back href={back} label="Game accounts" /><InlineError error={q.error} onRetry={() => void q.refetch()} /></div>;

  const e = q.data;
  const tags = Array.isArray(e.tags) ? e.tags : [];
  return (
    <EntryDetail
      tone="t-slate" backHref={back} backLabel="Game accounts" eyebrow={`Game · ${e.category}`}
      title={e.username || `Entry #${e.id}`} sub={[e.rank, e.level && `Lv ${e.level}`].filter(Boolean).join(" · ") || undefined}
      manageHref={back} manageLabel="Edit from list"
      kpis={[["Rank", e.rank ?? "—"], ["Level", e.level ?? "—"], ["Account age", e.account_age ?? "—"], ["Added", day(e.created_at) ?? "—"]]}
      sections={[
        { title: "Account", rows: [
          { label: "Username", value: e.username }, { label: "Password", value: e.account_password, secret: true },
        ] },
        { title: "Email", rows: [
          { label: "Email", value: e.email }, { label: "Email pass", value: e.email_password, secret: true },
          { label: "Email 2FA", value: e.email_2fa, secret: true }, { label: "Backup code", value: e.email_backup_code, secret: true },
        ] },
        { title: "Notes", rows: [{ label: "Notes", value: e.notes }, { label: "Tags", value: tags.length ? tags.map((t) => `#${t}`).join("  ") : null }] },
      ]}
      onDelete={() => del.mutate()} deleting={del.isPending}
      deleteError={del.error ? "Couldn’t delete this entry. Try again." : null}
    />
  );
}
