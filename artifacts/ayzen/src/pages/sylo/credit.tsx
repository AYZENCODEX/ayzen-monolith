/**
 * pages/sylo/credit.tsx — /vault/credit
 * Buy AZN. Price comes from Sylo's own price list (initially $0.01 = ৳1.27 per AZN).
 * Pay with a saved method, send the money, paste the transaction ID, and the
 * order waits for verification on the Order page.
 */
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  QK, syloCredit, errorMessage, fmtAzn, fmtBdt, fmtUsd, maskAccount, payCurrency, payKindLabel, type PaymentMethod,
} from "@/lib/sylo-credit-api";
import { Card, Head, Kpis, ListState } from "./credit-ui";

const QUICK = [100, 500, 1_000, 5_000, 10_000];

export default function SyloCredit() {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const summary = useQuery({ queryKey: QK.summary, queryFn: syloCredit.summary });
  const methods = useQuery({ queryKey: QK.methods, queryFn: syloCredit.methods });

  const [amount, setAmount] = useState("");
  const [picked, setPicked] = useState<number | null>(null);
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);

  const pricing = summary.data?.pricing;
  const list = methods.data?.methods ?? [];
  const method: PaymentMethod | undefined = list.find((m) => m.id === picked) ?? list.find((m) => m.isDefault) ?? list[0];
  const azn = Number(amount);
  const valid = Number.isFinite(azn) && azn > 0;

  const totals = useMemo(() => {
    if (!pricing || !valid) return null;
    return { usd: Math.round(azn * pricing.priceUsd * 1e4) / 1e4, bdt: Math.round(azn * pricing.priceBdt * 100) / 100 };
  }, [pricing, azn, valid]);

  const payTo = useMemo(() => {
    const p = summary.data?.payTo;
    if (!p || !method) return null;
    const dest = method.kind === "bkash" ? p.bkash : method.kind === "nagad" ? p.nagad : p.binance;
    return dest ? { dest, network: method.kind === "wallet" || method.kind === "binance" ? p.network : null } : null;
  }, [summary.data, method]);

  const buy = useMutation({
    mutationFn: () => syloCredit.buy({ aznAmount: azn, paymentMethodId: method!.id, referenceId: reference.trim() }),
    onSuccess: async ({ order }) => {
      await Promise.all([qc.invalidateQueries({ queryKey: QK.orders }), qc.invalidateQueries({ queryKey: QK.summary })]);
      navigate(`/vault/credit/orders/${order.id}`);
    },
    onError: (e) => setError(errorMessage(e, "Couldn’t place the order. Nothing was charged. Try again.")),
  });

  const submit = () => {
    setError(null);
    if (!pricing) return;
    if (!valid) return setError("Enter how many AZN to buy.");
    if (azn < pricing.minAzn) return setError(`The minimum order is ${fmtAzn(pricing.minAzn)} AZN.`);
    if (!method) return setError("Add a payment method first.");
    if (reference.trim().length < 6) return setError("Enter the transaction ID or hash from your payment.");
    buy.mutate();
  };

  const s = summary.data;
  const pay = method ? payCurrency(method.kind) : null;

  return (
    <div className="stack t-moss">
      <Head eyebrow="Credit" title="Buy AZN" sub="AZN powers Sylo actions. Buy it with bKash, Nagad, Binance or a wallet." />
      <Kpis items={[
        ["AZN balance", s ? fmtAzn(s.aznBalance) : "…", "available to spend"],
        ["Price per AZN", pricing ? fmtUsd(pricing.priceUsd) : "…", pricing ? `${fmtBdt(pricing.priceBdt)} in BDT` : undefined],
        ["Minimum order", pricing ? `${fmtAzn(pricing.minAzn)} AZN` : "…"],
        ["Pending orders", s ? s.pendingOrders : "…", <Link href="/vault/credit/orders" className="mono" key="o">View orders ›</Link>],
      ]} />

      <Card title="Amount">
        <div className="fld">
          <label htmlFor="azn">AZN to buy</label>
          <div className="in" style={{ color: "var(--tx)" }}>
            <input id="azn" inputMode="decimal" type="number" min={pricing?.minAzn} step="any" value={amount} placeholder={pricing ? String(pricing.minAzn) : "100"}
              onChange={(e) => setAmount(e.target.value)} />
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {QUICK.map((q) => (
            <button type="button" key={q} className={`chip ${azn === q ? "on" : ""}`} onClick={() => setAmount(String(q))}>{fmtAzn(q)}</button>
          ))}
        </div>
        <dl className="dl" style={{ gridTemplateColumns: "130px 1fr", marginTop: 16 }}>
          <dt>In USD</dt><dd className="num">{totals ? fmtUsd(totals.usd) : "—"}</dd>
          <dt>In BDT</dt><dd className="num">{totals ? fmtBdt(totals.bdt) : "—"}</dd>
        </dl>
      </Card>

      <Card title="Pay with" note={<Link href="/vault/credit/payment-methods/new">+ Add</Link>} flush>
        <ListState pending={methods.isPending} error={methods.error} retry={() => void methods.refetch()} empty={list.length === 0}
          emptyTitle="No payment method yet" emptyHint="Save a bKash, Nagad, Binance or wallet account to pay with."
          action={<Link href="/vault/credit/payment-methods/new" className="btn p">Add payment method</Link>} />
        <div role="radiogroup" aria-label="Payment method">
          {list.map((m) => (
            <button type="button" role="radio" aria-checked={method?.id === m.id} key={m.id} className="row go"
              style={{ padding: "14px 18px", width: "100%", textAlign: "left", background: method?.id === m.id ? "var(--ac-d)" : "transparent", border: 0 }}
              onClick={() => setPicked(m.id)}>
              <span className="mk">{m.kind.slice(0, 2).toUpperCase()}</span>
              <div className="g"><b>{m.label || payKindLabel(m.kind)}</b><span>{payKindLabel(m.kind)} · {maskAccount(m.account)}{m.network ? ` · ${m.network}` : ""}</span></div>
              {m.isDefault && <span className="pill ac">Default</span>}
            </button>
          ))}
        </div>
      </Card>

      {method && (
        <Card title="Send payment">
          {payTo ? (
            <>
              <p style={{ margin: "0 0 12px", color: "var(--mu)" }}>
                Send exactly <b className="num" style={{ color: "var(--tx)" }}>{totals ? (pay === "BDT" ? fmtBdt(totals.bdt) : fmtUsd(totals.usd)) : "the total"}</b>{" "}
                with {payKindLabel(method.kind)} to:
              </p>
              <div className="code"><span style={{ wordBreak: "break-all" }}>{payTo.dest}</span></div>
              {payTo.network && <div className="hint" style={{ marginTop: 8 }}>Network: {payTo.network}</div>}
            </>
          ) : (
            <p style={{ margin: 0, color: "var(--mu)" }}>Payment details for {payKindLabel(method.kind)} aren’t set up yet. Pick another method or contact support.</p>
          )}
          <div className="fld" style={{ marginTop: 16 }}>
            <label htmlFor="ref">Transaction ID / hash</label>
            <div className="in" style={{ color: "var(--tx)" }}>
              <input id="ref" value={reference} autoComplete="off" placeholder="e.g. 9H7K2LMNQ1" onChange={(e) => setReference(e.target.value)} />
            </div>
            <div className="hint">Paste it after you pay. We verify it before adding AZN.</div>
          </div>
        </Card>
      )}

      {error && <div className="note" role="alert"><b>{error}</b></div>}

      <div className="actionbar">
        <Link href="/vault" className="btn">Cancel</Link>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn p" disabled={buy.isPending || !method || !payTo} onClick={submit}>
          {buy.isPending ? "Placing order…" : totals ? `Place order · ${fmtAzn(azn)} AZN` : "Place order"}
        </button>
      </div>
    </div>
  );
}
