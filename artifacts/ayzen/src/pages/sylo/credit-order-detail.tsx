/** pages/sylo/credit-order-detail.tsx — /vault/credit/orders/:id */
import { Link, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { NotFoundPage, InlineError } from "@/components/console";
import { ApiError } from "@workspace/api-client-react";
import { QK, syloCredit, fmtAzn, fmtBdt, fmtDate, fmtUsd, payCurrency, payKindLabel, maskAccount } from "@/lib/sylo-credit-api";
import { Back, Card, Head, Kpis, StatusPill } from "./credit-ui";

export default function SyloCreditOrderDetail() {
  const { id = "" } = useParams<{ id: string }>();
  const q = useQuery({ queryKey: QK.order(id), queryFn: () => syloCredit.order(id), retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2 });

  if (q.error instanceof ApiError && q.error.status === 404) return <NotFoundPage embedded />;
  if (q.isPending) return <div className="stack" role="status"><Back href="/vault/credit/orders" label="Orders" /><div className="card"><div className="body">Loading…</div></div></div>;
  if (q.error || !q.data) return <div className="stack"><Back href="/vault/credit/orders" label="Orders" /><InlineError error={q.error} onRetry={() => void q.refetch()} /></div>;

  const o = q.data.order;
  const cur = payCurrency(o.payKind);
  const steps = [
    { t: "Order placed", d: fmtDate(o.createdAt), done: true },
    { t: o.status === "rejected" ? "Rejected" : "Payment verified", d: o.approvedAt ? fmtDate(o.approvedAt) : o.status === "pending" ? "Waiting — usually 1–2 hours" : "—", done: o.status !== "pending" },
    { t: "AZN added to balance", d: o.status === "approved" ? "Done" : "—", done: o.status === "approved" },
  ];

  return (
    <div className="stack t-moss">
      <Back href="/vault/credit/orders" label="Orders" />
      <Head eyebrow={`Credit · ${o.orderNo}`} title={`${fmtAzn(o.aznAmount)} AZN`} sub={`${payKindLabel(o.payKind)} · placed ${fmtDate(o.createdAt)}`} acts={<StatusPill status={o.status} />} />
      <Kpis items={[
        ["AZN", fmtAzn(o.aznAmount)],
        ["Total", cur === "BDT" ? fmtBdt(o.totalBdt) : fmtUsd(o.totalUsd), cur === "BDT" ? fmtUsd(o.totalUsd) : fmtBdt(o.totalBdt)],
        ["Unit price", fmtUsd(o.unitPriceUsd), fmtBdt(o.unitPriceBdt)],
      ]} />
      {o.status === "rejected" && <div className="note" role="alert"><b>This order was rejected.</b> {o.adminNote ?? "Check the transaction ID and place a new order."}</div>}
      <Card title="Progress" flush>
        {steps.map((s) => (
          <div className="row" key={s.t} style={{ padding: "14px 18px" }}>
            <span className="mk" style={{ opacity: s.done ? 1 : 0.45 }}>{s.done ? "✓" : "·"}</span>
            <div className="g"><b>{s.t}</b><span>{s.d}</span></div>
          </div>
        ))}
      </Card>
      <Card title="Payment">
        <dl className="dl" style={{ gridTemplateColumns: "140px 1fr" }}>
          <dt>Method</dt><dd>{payKindLabel(o.payKind)} · <span className="mono">{maskAccount(o.payAccount)}</span></dd>
          <dt>Transaction ID</dt><dd className="mono" style={{ wordBreak: "break-all" }}>{o.referenceId}</dd>
          <dt>Order number</dt><dd className="mono">{o.orderNo}</dd>
        </dl>
      </Card>
      <div className="actionbar"><Link href="/vault/credit/orders" className="btn">Back to orders</Link></div>
    </div>
  );
}
