/** pages/sylo/game-detail.tsx — /vault/game/:id (full page, replaces the card quick-view) */
import { useState } from "react";
import { Link, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { customFetch, ApiError } from "@workspace/api-client-react";
import { NotFoundPage, InlineError } from "@/components/console";
import type { GameEntry } from "@/components/game-entries";
import { accountPath } from "@/lib/sylo-routes";
import { Back, Card, Head } from "./credit-ui";

const SECRET = new Set(["Account password", "Email password", "Email 2FA", "Backup code"]);

export default function SyloGameDetail() {
  const { id = "" } = useParams<{ id: string }>();
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const q = useQuery({
    queryKey: ["sylo", "game", id],
    queryFn: () => customFetch<GameEntry>(`/api/game-entries/${encodeURIComponent(id)}`),
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2,
  });
  const back = accountPath("game", "management");

  if (q.error instanceof ApiError && q.error.status === 404) return <NotFoundPage embedded />;
  if (q.isPending) return <div className="stack" role="status"><Back href={back} label="Game accounts" /><div className="card"><div className="body">Loading…</div></div></div>;
  if (q.error || !q.data) return <div className="stack"><Back href={back} label="Game accounts" /><InlineError error={q.error} onRetry={() => void q.refetch()} /></div>;

  const e = q.data;
  const rows: [string, string | null][] = [
    ["Username", e.username], ["Account password", e.account_password],
    ["Email", e.email], ["Email password", e.email_password], ["Email 2FA", e.email_2fa], ["Backup code", e.email_backup_code],
    ["Rank", e.rank], ["Level", e.level], ["Account age", e.account_age],
  ];
  return (
    <div className="stack t-moss">
      <Back href={back} label="Game accounts" />
      <Head eyebrow={`Game · ${e.category}`} title={e.username || `Entry #${e.id}`} sub={`Added ${new Date(e.created_at).toLocaleDateString()}`}
        acts={<Link href={back} className="btn">Edit from list</Link>} />
      <Card title="Details" flush>
        {rows.filter(([, v]) => v).map(([k, v]) => {
          const secret = SECRET.has(k);
          return (
            <div className="row" key={k} style={{ padding: "14px 18px" }}>
              <div className="g"><b>{k}</b><span className="mono">{secret && !shown[k] ? "••••••••" : v}</span></div>
              {secret && <button type="button" className="btn" onClick={() => setShown({ ...shown, [k]: !shown[k] })}>{shown[k] ? "Hide" : "Show"}</button>}
            </div>
          );
        })}
      </Card>
      {(e.notes || (e.tags && e.tags.length > 0)) && (
        <Card title="Notes">
          {e.notes && <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{e.notes}</p>}
          {e.tags && e.tags.length > 0 && <p className="mono" style={{ marginTop: 10 }}>{e.tags.map((t) => `#${t}`).join("  ")}</p>}
        </Card>
      )}
    </div>
  );
}
