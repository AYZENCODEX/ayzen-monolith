/** pages/sylo/entity-detail.tsx — /vault/entity/:id (full tooling lives at /vault/entity/:id/manage) */
import { useParams, useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch, ApiError } from "@workspace/api-client-react";
import { NotFoundPage, InlineError } from "@/components/console";
import { accountPath } from "@/lib/sylo-routes";
import { Back, Card } from "./credit-ui";
import { EntryDetail, Reveal, day } from "./entry-detail";

interface Entity {
  id: number; projectName: string; entitySerial?: string | null; email?: string | null; status?: string | null;
  twitterUsername?: string | null; discordUsername?: string | null; telegramUsername?: string | null;
  walletAddresses?: string[]; backupCodes?: string[]; notes?: string | null; createdAt: string; updatedAt?: string;
}

export default function SyloEntityDetail() {
  const { id = "" } = useParams<{ id: string }>();
  const [, go] = useLocation();
  const qc = useQueryClient();
  const back = accountPath("entity", "management");
  const q = useQuery({
    queryKey: ["sylo", "entity", id],
    queryFn: () => customFetch<Entity>(`/api/vault/${encodeURIComponent(id)}`),
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2,
  });
  const del = useMutation({
    mutationFn: () => customFetch(`/api/vault/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["sylo"] }); go(back); },
  });

  if (q.error instanceof ApiError && q.error.status === 404) return <NotFoundPage embedded />;
  if (q.isPending) return <div className="stack" role="status"><Back href={back} label="Entities" /><div className="card"><div className="body">Loading…</div></div></div>;
  if (q.error || !q.data) return <div className="stack"><Back href={back} label="Entities" /><InlineError error={q.error} onRetry={() => void q.refetch()} /></div>;

  const e = q.data;
  const wallets = e.walletAddresses ?? [];
  const codes = e.backupCodes ?? [];
  const flagged = e.status && e.status !== "active";
  return (
    <EntryDetail
      tone="t-brass" backHref={back} backLabel="Entities" eyebrow={`Entity${e.entitySerial ? ` · ${e.entitySerial}` : ""}`}
      title={e.projectName} sub={e.email ?? undefined}
      badge={flagged ? <span className="pill warn">{e.status}</span> : <span className="pill ok">Active</span>}
      manageHref={`/vault/entity/${e.id}/manage`}
      kpis={[
        ["Wallets", String(wallets.length)], ["Backup codes", String(codes.length)],
        ["Added", day(e.createdAt) ?? "—"], ["Updated", day(e.updatedAt) ?? "—"],
      ]}
      sections={[
        { title: "Handles", rows: [
          { label: "Email", value: e.email }, { label: "Twitter", value: e.twitterUsername },
          { label: "Discord", value: e.discordUsername }, { label: "Telegram", value: e.telegramUsername },
        ] },
        { title: "Notes", rows: [{ label: "Notes", value: e.notes }] },
      ]}
      extra={<>
        {wallets.length > 0 && (
          <Card title="Wallet addresses" note={String(wallets.length)} flush>
            {wallets.map((w, i) => <div className="row" key={i} style={{ padding: "14px 18px" }}><div className="g"><span className="mono" style={{ color: "var(--tx)", overflowWrap: "anywhere" }}>{w}</span></div></div>)}
          </Card>
        )}
        {codes.length > 0 && (
          <Card title="Backup codes" note={String(codes.length)} flush>
            {codes.map((c, i) => <div className="row" key={i} style={{ padding: "14px 18px" }}><div className="g"><Reveal value={c} /></div></div>)}
          </Card>
        )}
      </>}
      onDelete={() => del.mutate()} deleting={del.isPending}
      deleteError={del.error ? "Couldn’t delete this entity. Try again." : null}
    />
  );
}
