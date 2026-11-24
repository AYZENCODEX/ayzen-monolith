/** pages/sylo/credit-orders.tsx — /vault/credit/orders : every AZN purchase, newest first. */
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { QK, syloCredit, fmtAzn, fmtBdt, fmtDate, fmtUsd, payCurrency, payKindLabel } from "@/lib/sylo-credit-api";
import { Card, Head, Kpis, ListState, StatusPill } from "./credit-ui";

export default function SyloCreditOrders() {
  const q = useQuery({ queryKey: QK.orders, queryFn: syloCredit.orders });
  const orders = q.data?.orders ?? [];
  const bought = orders.filter((o) => o.status === "approved").reduce((a, o) => a + o.aznAmount, 0);

  return (
    <div className="stack t-moss">
      <Head eyebrow="Credit · Order" title="Orders" sub="Your AZN purchases and where each one stands."
        acts={<Link href="/vault/credit" className="btn p">+ Buy AZN</Link>} />
      <Kpis items={[
        ["Orders", q.isPending ? "…" : orders.length],
        ["AZN bought", q.isPending ? "…" : fmtAzn(bought), "approved orders"],
        ["Pending", q.isPending ? "…" : orders.filter((o) => o.status === "pending").length, "waiting for verification"],
      ]} />
      <Card title="Purchase history" note={orders.length ? `${orders.length}` : ""} flush>
        <ListState pending={q.isPending} error={q.error} retry={() => void q.refetch()} empty={orders.length === 0}
          emptyTitle="No orders yet" emptyHint="Your AZN purchases will show up here." action={<Link href="/vault/credit" className="btn p">Buy AZN</Link>} />
        {orders.map((o) => (
          <Link key={o.id} href={`/vault/credit/orders/${o.id}`} className="row go" style={{ padding: "14px 18px" }}>
            <span className="mk">AZ</span>
            <div className="g">
              <b>{fmtAzn(o.aznAmount)} AZN</b>
              <span>{o.orderNo} · {payKindLabel(o.payKind)} · {fmtDate(o.createdAt)}</span>
            </div>
            <span className="num" style={{ marginRight: 8 }}>{payCurrency(o.payKind) === "BDT" ? fmtBdt(o.totalBdt) : fmtUsd(o.totalUsd)}</span>
            <StatusPill status={o.status} />
          </Link>
        ))}
      </Card>
    </div>
  );
}
