/**
 * pages/sylo/entry-detail.tsx — shared full-page detail for Local and KYC entries.
 * Layout follows the approved prototype: head + KPIs, then stacked cards
 * (credentials with Reveal, stats, dates, extras) and a danger zone.
 * The legacy page with mail / 2FA / edit tooling stays at …/manage.
 */
import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { Back, Card, Head, Kpis } from "./credit-ui";

export interface DetailRow { label: string; value: ReactNode; secret?: boolean }
export interface DetailSection { title: string; note?: ReactNode; rows: DetailRow[] }

export function Reveal({ value }: { value: string }) {
  const [on, setOn] = useState(false);
  return (
    <>
      <span className="mono">{on ? value : "••••••••••"}</span>{" "}
      <button type="button" className="reveal" onClick={() => setOn((v) => !v)}
        style={{ background: "none", border: 0, color: "var(--ac)", font: "500 10px var(--mono)", letterSpacing: ".08em", textTransform: "uppercase", cursor: "pointer" }}>
        {on ? "Hide" : "Reveal"}
      </button>
    </>
  );
}

export function EntryDetail(props: {
  backHref: string; backLabel: string; eyebrow: string; title: string; sub?: string;
  badge?: ReactNode; manageHref: string; manageLabel?: string; kpis: [string, ReactNode, ReactNode?][];
  sections: DetailSection[]; extra?: ReactNode;
  onDelete: () => void; deleting: boolean; deleteError?: string | null; tone?: string;
}) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div className={`stack ${props.tone ?? "t-patina"}`}>
      <Back href={props.backHref} label={props.backLabel} />
      <Head eyebrow={props.eyebrow} title={props.title} sub={props.sub}
        acts={<>{props.badge}<Link href={props.manageHref} className="btn p">{props.manageLabel ?? "Edit & mail / 2FA"}</Link></>} />
      <Kpis items={props.kpis} />
      {props.sections.map((s) => {
        const rows = s.rows.filter((r) => r.value !== null && r.value !== undefined && r.value !== "");
        if (rows.length === 0) return null;
        return (
          <Card key={s.title} title={s.title} note={s.note} flush>
            {rows.map((r) => (
              <div className="row" key={r.label} style={{ padding: "14px 18px" }}>
                <span className="mono" style={{ width: 130, flex: "none", color: "var(--di)", fontSize: 10, letterSpacing: ".1em", textTransform: "uppercase" }}>{r.label}</span>
                <div className="g">
                  {r.secret && typeof r.value === "string" ? <Reveal value={r.value} /> : <span className="mono" style={{ color: "var(--tx)", overflowWrap: "anywhere" }}>{r.value}</span>}
                </div>
              </div>
            ))}
          </Card>
        );
      })}
      {props.extra}
      <Card title="Danger zone" flush>
        <div className="row" style={{ padding: "14px 18px" }}>
          <div className="g"><b>Delete this entry</b><span>{confirm ? "This cannot be undone. Press again to confirm." : "Removes it from your vault."}</span></div>
          <button type="button" className="btn" disabled={props.deleting}
            onClick={() => (confirm ? props.onDelete() : setConfirm(true))}>
            {props.deleting ? "Deleting…" : confirm ? "Confirm delete" : "Delete"}
          </button>
        </div>
        {props.deleteError && <div className="note" role="alert" style={{ margin: "0 18px 14px" }}>{props.deleteError}</div>}
      </Card>
    </div>
  );
}

export const money = (n: number | null | undefined) => (n === null || n === undefined ? null : `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
export const day = (s: string | null | undefined) => (s ? new Date(s).toISOString().slice(0, 10) : null);
export function roi(worth: number | null | undefined, buy: number | null | undefined) {
  if (!buy || worth === null || worth === undefined) return null;
  const v = ((worth - buy) / buy) * 100;
  return `${v >= 0 ? "+" : ""}${v.toFixed(0)}%`;
}
