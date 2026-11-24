/** pages/sylo/credit-usage.tsx — /vault/credit/usage : what metered Sylo actions have spent. */
import { useQuery } from "@tanstack/react-query";
import { QK, syloCredit, fmtAzn, fmtDate } from "@/lib/sylo-credit-api";
import { Card, Head, Kpis, ListState } from "./credit-ui";

const prettyAction = (k: string | null) =>
  (k ?? "action").replace(/^sylo\./, "").replace(/[._]/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export default function SyloCreditUsage() {
  const q = useQuery({ queryKey: QK.usage, queryFn: syloCredit.usage });
  const u = q.data;
  const max = Math.max(1, ...(u?.byAction.map((a) => a.spent) ?? [1]));

  return (
    <div className="stack t-moss">
      <Head eyebrow="Credit · Usage" title="Usage" sub="Credits spent by Sylo actions. Core vault use stays free." />
      <Kpis items={[
        ["Credit balance", u ? fmtAzn(u.balance) : "…", "available"],
        ["Spent, 30 days", u ? fmtAzn(u.spent30d) : "…", "credits"],
        ["Actions used", u ? u.byAction.reduce((a, r) => a + r.uses, 0) : "…", "last 30 days"],
      ]} />
      <Card title="By action" note="30 days" flush>
        <ListState pending={q.isPending} error={q.error} retry={() => void q.refetch()} empty={!!u && u.byAction.length === 0}
          emptyTitle="No usage yet" emptyHint="When a paid Sylo action runs, it appears here." />
        {u?.byAction.map((a) => (
          <div className="row" key={a.actionKey ?? "x"} style={{ padding: "12px 18px" }}>
            <div className="g"><b>{prettyAction(a.actionKey)}</b><span>{a.uses} use{a.uses === 1 ? "" : "s"}</span></div>
            <div style={{ width: 140 }} aria-hidden="true"><div className="bar"><i style={{ width: `${Math.round((a.spent / max) * 100)}%` }} /></div></div>
            <span className="num" style={{ width: 70, textAlign: "right" }}>{fmtAzn(a.spent)}</span>
          </div>
        ))}
      </Card>
      <Card title="Recent activity" note={u?.entries.length ? `${u.entries.length}` : ""} flush>
        {u?.entries.length === 0 && !q.isPending && <div className="row" style={{ padding: "16px 18px" }}><div className="g"><span>Nothing yet.</span></div></div>}
        {u?.entries.map((e) => (
          <div className="row" key={e.id} style={{ padding: "12px 18px" }}>
            <div className="g"><b>{prettyAction(e.actionKey)}</b><span>{e.type === "usage_refund" ? "Refund · " : ""}{fmtDate(e.createdAt)}</span></div>
            <span className={`num ${e.credits < 0 ? "" : "up"}`}>{e.credits > 0 ? "+" : ""}{fmtAzn(e.credits)}</span>
          </div>
        ))}
      </Card>
    </div>
  );
}
