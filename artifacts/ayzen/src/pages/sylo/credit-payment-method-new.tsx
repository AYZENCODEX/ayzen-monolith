/** pages/sylo/credit-payment-method-new.tsx — /vault/credit/payment-methods/new */
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PAY_KINDS, QK, WALLET_NETWORKS, errorMessage, syloCredit, type PayKind } from "@/lib/sylo-credit-api";
import { Back, Card, Head } from "./credit-ui";

const PLACEHOLDER: Record<PayKind, string> = {
  bkash: "01712345678", nagad: "01712345678", binance: "Binance Pay ID, e.g. 123456789", wallet: "Wallet address",
};

export default function SyloCreditPaymentMethodNew() {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [kind, setKind] = useState<PayKind>("bkash");
  const [label, setLabel] = useState("");
  const [account, setAccount] = useState("");
  const [network, setNetwork] = useState<string>("TRC20");
  const [makeDefault, setMakeDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => syloCredit.addMethod({ kind, label: label.trim() || undefined, account, network: kind === "wallet" ? network : undefined, makeDefault }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: QK.methods }); navigate("/vault/credit/payment-methods"); },
    onError: (e) => setError(errorMessage(e, "Couldn’t save. Check the details and try again.")),
  });
  const hint = PAY_KINDS.find((k) => k.id === kind)!.hint;

  return (
    <div className="stack t-moss">
      <Back href="/vault/credit/payment-methods" label="Payment methods" />
      <Head eyebrow="Credit · Payment method · Add" title="Add payment method" sub="Save an account to pay with, once." />
      <Card title="Type">
        <div role="radiogroup" aria-label="Payment type" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {PAY_KINDS.map((k) => (
            <button type="button" role="radio" aria-checked={kind === k.id} key={k.id} className={`chip ${kind === k.id ? "on" : ""}`} onClick={() => { setKind(k.id); setError(null); }}>{k.label}</button>
          ))}
        </div>
      </Card>
      <Card title="Details">
        <div className="fld">
          <label htmlFor="pm-account">{hint}</label>
          <div className="in" style={{ color: "var(--tx)" }}>
            <input id="pm-account" value={account} autoComplete="off" inputMode={kind === "wallet" ? "text" : "numeric"} placeholder={PLACEHOLDER[kind]} onChange={(e) => setAccount(e.target.value)} />
          </div>
        </div>
        {kind === "wallet" && (
          <div className="fld">
            <label>Network</label>
            <div role="radiogroup" aria-label="Network" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {WALLET_NETWORKS.map((n) => <button type="button" role="radio" aria-checked={network === n} key={n} className={`chip ${network === n ? "on" : ""}`} onClick={() => setNetwork(n)}>{n}</button>)}
            </div>
          </div>
        )}
        <div className="fld">
          <label htmlFor="pm-label">Label <span style={{ color: "var(--di)", textTransform: "none", letterSpacing: 0 }}>optional</span></label>
          <div className="in" style={{ color: "var(--tx)" }}>
            <input id="pm-label" value={label} maxLength={60} placeholder="e.g. My personal bKash" onChange={(e) => setLabel(e.target.value)} />
          </div>
        </div>
        <div className="row" style={{ padding: "6px 0 0" }}>
          <div className="g"><b style={{ fontWeight: 500 }}>Use as default</b></div>
          <button type="button" role="switch" aria-checked={makeDefault} aria-label="Use as default" className={`tgl ${makeDefault ? "on" : ""}`} onClick={() => setMakeDefault(!makeDefault)}><i /></button>
        </div>
      </Card>
      {error && <div className="note" role="alert"><b>{error}</b></div>}
      <div className="actionbar">
        <Link href="/vault/credit/payment-methods" className="btn">Cancel</Link>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn p" disabled={save.isPending || !account.trim()} onClick={() => { setError(null); save.mutate(); }}>{save.isPending ? "Saving…" : "Save method"}</button>
      </div>
    </div>
  );
}
