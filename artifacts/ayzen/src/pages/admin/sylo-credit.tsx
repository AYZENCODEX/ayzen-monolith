/**
 * pages/admin/sylo-credit.tsx — /admin/sylo-credit
 * Admin side of Sylo's credit storefront: verify pending AZN orders and set the
 * AZN price. Backed by routes/sylo-credit.ts (/admin/sylo/credit/*).
 */
import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Check, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { InlineError } from "@/components/console";
import { errorMessage, fmtAzn, fmtBdt, fmtDate, fmtUsd, payKindLabel, type Order } from "@/lib/sylo-credit-api";

const ORDERS_KEY = ["admin-sylo-credit", "orders"] as const;
const PRICING_KEY = ["sylo-credit", "summary"] as const;

export default function AdminSyloCreditPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const orders = useQuery({ queryKey: ORDERS_KEY, queryFn: () => customFetch<{ orders: Order[] }>("/api/admin/sylo/credit/orders") });
  const pricing = useQuery({ queryKey: PRICING_KEY, queryFn: () => customFetch<{ pricing: { priceUsd: number; priceBdt: number; minAzn: number } }>("/api/sylo/credit/summary") });
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [price, setPrice] = useState<{ usd: string; bdt: string; min: string } | null>(null);
  const p = pricing.data?.pricing;
  const form = price ?? (p ? { usd: String(p.priceUsd), bdt: String(p.priceBdt), min: String(p.minAzn) } : null);

  const act = useMutation({
    mutationFn: ({ id, kind }: { id: number; kind: "approve" | "reject" }) =>
      customFetch(`/api/admin/sylo/credit/orders/${id}/${kind}`, { method: "POST", body: JSON.stringify({ note: notes[id] ?? "" }) }),
    onSuccess: (_d, v) => { toast({ title: v.kind === "approve" ? "Approved — AZN added" : "Order rejected" }); void qc.invalidateQueries({ queryKey: ORDERS_KEY }); },
    onError: (e) => toast({ variant: "destructive", title: errorMessage(e, "Action failed") }),
  });
  const savePrice = useMutation({
    mutationFn: () => customFetch("/api/admin/sylo/credit/pricing", { method: "PUT", body: JSON.stringify({ priceUsd: Number(form!.usd), priceBdt: Number(form!.bdt), minAzn: Number(form!.min) }) }),
    onSuccess: () => { toast({ title: "Price list saved" }); setPrice(null); void qc.invalidateQueries({ queryKey: PRICING_KEY }); },
    onError: (e) => toast({ variant: "destructive", title: errorMessage(e, "Couldn’t save the price list") }),
  });

  const list = orders.data?.orders ?? [];
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase">Sylo credit</h1>
        <p className="text-muted-foreground font-mono text-xs mt-1">
          {list.length} pending order{list.length === 1 ? "" : "s"} · <Link href="/admin/credits" className="underline">AYZEN credits</Link>
        </p>
      </div>

      <section className="rounded-xl border border-border bg-card p-4 space-y-3">
        <h2 className="font-mono text-xs uppercase tracking-wider text-muted-foreground">AZN price list</h2>
        {form ? (
          <div className="grid gap-3 sm:grid-cols-4 items-end">
            {([["usd", "Price per AZN (USD)"], ["bdt", "Price per AZN (BDT)"], ["min", "Minimum order (AZN)"]] as const).map(([k, l]) => (
              <label key={k} className="space-y-1 font-mono text-[10px] uppercase text-muted-foreground">
                {l}
                <Input type="number" step="any" min="0" value={form[k]} onChange={(e) => setPrice({ ...form, [k]: e.target.value })} className="font-mono text-xs h-9" />
              </label>
            ))}
            <Button disabled={savePrice.isPending || !price} onClick={() => savePrice.mutate()}>{savePrice.isPending ? "Saving…" : "Save prices"}</Button>
          </div>
        ) : <Loader2 className="w-4 h-4 animate-spin" aria-label="Loading" />}
      </section>

      <section className="space-y-3">
        <h2 className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Pending orders</h2>
        {orders.isPending && <Loader2 className="w-4 h-4 animate-spin" aria-label="Loading" />}
        {orders.error && <InlineError error={orders.error} onRetry={() => void orders.refetch()} />}
        {!orders.isPending && !orders.error && list.length === 0 && <p className="font-mono text-xs text-muted-foreground">Nothing waiting for verification.</p>}
        {list.map((o) => (
          <div key={o.id} className="rounded-xl border border-border bg-card p-4 space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="font-mono text-sm font-bold">{o.orderNo} · {fmtAzn(o.aznAmount)} AZN</p>
                <p className="font-mono text-[11px] text-muted-foreground">{payKindLabel(o.payKind)} · {o.payAccount} · {fmtDate(o.createdAt)}</p>
              </div>
              <p className="font-mono text-sm">{fmtUsd(o.totalUsd)} · {fmtBdt(o.totalBdt)}</p>
            </div>
            <p className="font-mono text-[11px] break-all">TXN <span className="text-foreground">{o.referenceId}</span></p>
            <div className="flex flex-wrap gap-2">
              <Input placeholder="Note (optional)" value={notes[o.id] ?? ""} onChange={(e) => setNotes({ ...notes, [o.id]: e.target.value })} className="font-mono text-xs h-9 flex-1 min-w-[180px]" />
              <Button size="sm" disabled={act.isPending} onClick={() => act.mutate({ id: o.id, kind: "approve" })}><Check className="w-3.5 h-3.5" /> Approve</Button>
              <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate({ id: o.id, kind: "reject" })}><X className="w-3.5 h-3.5" /> Reject</Button>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
