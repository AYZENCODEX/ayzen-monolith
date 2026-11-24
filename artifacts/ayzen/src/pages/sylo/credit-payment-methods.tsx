/** pages/sylo/credit-payment-methods.tsx — /vault/credit/payment-methods : saved bKash, Nagad, Binance and wallets. */
import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { QK, syloCredit, errorMessage, maskAccount, payKindLabel } from "@/lib/sylo-credit-api";
import { Card, Head, Kpis, ListState } from "./credit-ui";

export default function SyloCreditPaymentMethods() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: QK.methods, queryFn: syloCredit.methods });
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<number | null>(null);
  const done = () => qc.invalidateQueries({ queryKey: QK.methods });
  const setDefault = useMutation({ mutationFn: (id: number) => syloCredit.patchMethod(id, { makeDefault: true }), onSuccess: done, onError: (e) => setError(errorMessage(e, "Couldn’t update.")) });
  const remove = useMutation({ mutationFn: (id: number) => syloCredit.removeMethod(id), onSuccess: () => { setConfirm(null); return done(); }, onError: (e) => setError(errorMessage(e, "Couldn’t remove.")) });
  const list = q.data?.methods ?? [];

  return (
    <div className="stack t-moss">
      <Head eyebrow="Credit · Payment method" title="Payment methods" sub="Accounts you pay with when buying AZN."
        acts={<Link href="/vault/credit/payment-methods/new" className="btn p">+ Add method</Link>} />
      <Kpis items={[
        ["Saved", q.isPending ? "…" : list.length, "of 20"],
        ["Mobile wallets", q.isPending ? "…" : list.filter((m) => m.kind === "bkash" || m.kind === "nagad").length, "bKash · Nagad"],
        ["Crypto", q.isPending ? "…" : list.filter((m) => m.kind === "binance" || m.kind === "wallet").length, "Binance · wallets"],
      ]} />
      {error && <div className="note" role="alert"><b>{error}</b></div>}
      <Card title="Saved methods" note={list.length ? `${list.length}` : ""} flush>
        <ListState pending={q.isPending} error={q.error} retry={() => void q.refetch()} empty={list.length === 0}
          emptyTitle="Nothing saved yet" emptyHint="Add bKash, Nagad, Binance or a wallet address."
          action={<Link href="/vault/credit/payment-methods/new" className="btn p">Add payment method</Link>} />
        {list.map((m) => (
          <div className="row" key={m.id} style={{ padding: "14px 18px", flexWrap: "wrap" }}>
            <span className="mk">{m.kind.slice(0, 2).toUpperCase()}</span>
            <div className="g">
              <b>{m.label || payKindLabel(m.kind)}</b>
              <span>{payKindLabel(m.kind)} · {maskAccount(m.account)}{m.network ? ` · ${m.network}` : ""}</span>
            </div>
            {m.isDefault && <span className="pill ac">Default</span>}
            {!m.isDefault && <button type="button" className="btn" disabled={setDefault.isPending} onClick={() => setDefault.mutate(m.id)}>Make default</button>}
            {confirm === m.id
              ? <>
                  <button type="button" className="btn" onClick={() => setConfirm(null)}>Keep</button>
                  <button type="button" className="btn p" disabled={remove.isPending} onClick={() => remove.mutate(m.id)}>Remove</button>
                </>
              : <button type="button" className="btn" onClick={() => setConfirm(m.id)}>Remove</button>}
          </div>
        ))}
      </Card>
    </div>
  );
}
