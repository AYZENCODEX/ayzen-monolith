/** Small shared pieces for the Sylo credit pages (design classes live in styles/sylo-ui.css). */
import type { ReactNode } from "react";
import { Link } from "wouter";
import { InlineError } from "@/components/console";
import type { OrderStatus } from "@/lib/sylo-credit-api";

export const STATUS_PILL: Record<OrderStatus, { label: string; k: string }> = {
  pending: { label: "Pending", k: "warn" },
  approved: { label: "Approved", k: "ok" },
  rejected: { label: "Rejected", k: "bad" },
};

export function StatusPill({ status }: { status: OrderStatus }) {
  const s = STATUS_PILL[status];
  return <span className={`pill ${s.k}`}>{s.label}</span>;
}

export function Head({ eyebrow, title, sub, acts }: { eyebrow: string; title: string; sub?: string; acts?: ReactNode }) {
  return (
    <div className="ph">
      <div><div className="eb">{eyebrow}</div><h1>{title}</h1>{sub && <p>{sub}</p>}</div>
      {acts && <div className="acts">{acts}</div>}
    </div>
  );
}

export function Kpis({ items }: { items: [label: string, value: ReactNode, sub?: ReactNode][] }) {
  return (
    <div className="kpis">
      {items.map(([l, v, s]) => (
        <div className="kpi" key={l} style={{ ["--c" as string]: "var(--moss)" }}>
          <label>{l}</label><strong>{v}</strong><small>{s ?? " "}</small>
        </div>
      ))}
    </div>
  );
}

export function Card({ title, note, children, flush }: { title: string; note?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section className="card mb">
      <header><h3>{title}</h3><span>{note ?? ""}</span></header>
      {flush ? children : <div className="body">{children}</div>}
    </section>
  );
}

export function Back({ href, label }: { href: string; label: string }) {
  return <Link href={href} className="back">‹ {label}</Link>;
}

/** Loading / error / empty rows shared by every list on these pages. */
export function ListState({
  pending, error, retry, empty, emptyTitle, emptyHint, action,
}: { pending: boolean; error: unknown; retry: () => void; empty: boolean; emptyTitle: string; emptyHint: string; action?: ReactNode }) {
  if (pending) return <div className="row" style={{ padding: "16px 18px" }} role="status"><div className="g"><b>Loading…</b></div></div>;
  if (error) return <InlineError error={error} onRetry={retry} />;
  if (empty) {
    return (
      <div className="row" style={{ padding: "26px 18px", flexDirection: "column", alignItems: "flex-start", gap: 6 }}>
        <b style={{ fontWeight: 500 }}>{emptyTitle}</b>
        <span style={{ fontFamily: "var(--sans)" }}>{emptyHint}</span>
        {action}
      </div>
    );
  }
  return null;
}
