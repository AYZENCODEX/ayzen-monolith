/**
 * Analysis view: distribution and return charts per section. Entity uses the
 * server-side analytics rollup; local/KYC derive the same shape from their
 * (secret-free) summaries.
 */
import { BarChart3, TrendingDown, TrendingUp } from "lucide-react";
import {
  EmptyState, QueryBoundary, Widget, WidgetSkeleton,
} from "@/components/console";
import {
  useKycSummary, useLocalSummary, useVaultAnalytics,
  type AccountSummary, type Performer,
} from "@/hooks/use-sylo-data";
import { formatPct, formatSignedUsd, formatUsd, roiPct } from "@/lib/format-money";
import type { AccountSection } from "@/lib/sylo-routes";
import { cn } from "@/lib/utils";
import { HBarChart } from "../charts";

const usdAxis = (n: number) => formatUsd(n, { compact: true });

function RoiCell({ worth, buy }: { worth: number; buy: number }) {
  const roi = roiPct(worth, buy);
  if (roi === null) return <span className="text-muted-foreground">—</span>;
  return <span className={cn("font-medium tabular-nums", roi >= 0 ? "text-success" : "text-danger")}>{roi >= 0 ? "+" : ""}{formatPct(roi)}</span>;
}

function PerformerTable({ rows, kind }: { rows: Performer[]; kind: "best" | "worst" }) {
  const Icon = kind === "best" ? TrendingUp : TrendingDown;
  return (
    <ul className="divide-y divide-border/60">
      {rows.map((r) => (
        <li key={r.id} className="flex items-center gap-3 px-4 py-2.5">
          <Icon className={cn("size-4 shrink-0", kind === "best" ? "text-success" : "text-danger")} aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-foreground">{r.projectName}</span>
            <span className="block truncate text-xs text-muted-foreground">{r.entitySerial ?? `#${r.id}`}</span>
          </span>
          <span className="text-right text-xs text-muted-foreground tabular-nums">
            {formatUsd(r.currentValue)}
            <span className="block"><RoiCell worth={r.currentValue} buy={r.currentBuyValue} /></span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function EntityAnalysis() {
  const query = useVaultAnalytics();
  return (
    <QueryBoundary
      query={query}
      skeleton={<div className="grid gap-4 lg:grid-cols-2">{[0, 1, 2, 3].map((i) => <WidgetSkeleton key={i} announce={i === 0} rows={4} />)}</div>}
      isEmpty={(a) => a.overview.totalEntries === 0}
      empty={<EmptyState icon={BarChart3} title="Nothing to analyse yet" description="Add an entity and its worth will be charted here." />}
    >
      {(a) => {
        const projects = Object.entries(a.byProject)
          .map(([name, v]) => ({ name, value: v.totalValue }))
          .sort((x, y) => y.value - x.value).slice(0, 8);
        const platforms = (["twitter", "discord", "telegram"] as const).map((p) => ({
          name: p.charAt(0).toUpperCase() + p.slice(1), value: a.perPlatform[p].totalWorth,
        }));
        return (
          <div className="grid gap-4 lg:grid-cols-2">
            <Widget title="Worth by project" description="Top 8 by current value">
              <HBarChart data={projects} format={usdAxis} label="Entity worth by project" />
            </Widget>
            <Widget title="Worth by platform" description="Social platform accounts across all entities">
              <HBarChart data={platforms} format={usdAxis} label="Worth by platform" />
            </Widget>
            <Widget title="Best performing" description="Highest return on cost" padded={false}>
              {a.bestPerforming.length ? <PerformerTable rows={a.bestPerforming} kind="best" /> : <EmptyState icon={TrendingUp} title="No data" />}
            </Widget>
            <Widget title="Worst performing" description="Lowest return on cost" padded={false}>
              {a.worstPerforming.length ? <PerformerTable rows={a.worstPerforming} kind="worst" /> : <EmptyState icon={TrendingDown} title="No data" />}
            </Widget>
          </div>
        );
      }}
    </QueryBoundary>
  );
}

function CategoryAnalysis({ summary, noun }: { summary: AccountSummary; noun: string }) {
  const bars = summary.byCategory.slice(0, 8).map((c) => ({ name: c.category, value: c.worth }));
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Widget title="Worth by category" description={`Top 8 categories by total ${noun} worth`}>
        <HBarChart data={bars} format={usdAxis} label={`Worth by ${noun} category`} />
      </Widget>
      <Widget title="Category returns" description="Worth against cost basis" padded={false}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 text-left text-xs text-muted-foreground">
                <th scope="col" className="px-4 py-2 font-medium">Category</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Count</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Worth</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">P&amp;L</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">ROI</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {summary.byCategory.map((c) => (
                <tr key={c.category}>
                  <th scope="row" className="px-4 py-2 text-left font-medium text-foreground">{c.category}</th>
                  <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{c.count}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatUsd(c.worth)}</td>
                  <td className={cn("px-4 py-2 text-right tabular-nums", c.worth - c.buy >= 0 ? "text-success" : "text-danger")}>{formatSignedUsd(c.worth - c.buy)}</td>
                  <td className="px-4 py-2 text-right"><RoiCell worth={c.worth} buy={c.buy} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Widget>
    </div>
  );
}

const CATEGORY_SKELETON = (
  <div className="grid gap-4 lg:grid-cols-2">
    <WidgetSkeleton rows={5} />
    <WidgetSkeleton announce={false} rows={5} />
  </div>
);

function LocalAnalysis() {
  const query = useLocalSummary();
  return (
    <QueryBoundary query={query} skeleton={CATEGORY_SKELETON} isEmpty={(s) => s.total === 0}
      empty={<EmptyState icon={BarChart3} title="Nothing to analyse yet" description="Add local accounts and their worth will be charted here." />}>
      {(s) => <CategoryAnalysis summary={s} noun="local account" />}
    </QueryBoundary>
  );
}

function KycAnalysis() {
  const query = useKycSummary();
  return (
    <QueryBoundary query={query} skeleton={CATEGORY_SKELETON} isEmpty={(s) => s.total === 0}
      empty={<EmptyState icon={BarChart3} title="Nothing to analyse yet" description="Add KYC entries and their worth will be charted here." />}>
      {(s) => <CategoryAnalysis summary={s} noun="KYC" />}
    </QueryBoundary>
  );
}

export default function SectionAnalysis({ section }: { section: Exclude<AccountSection, "game"> }) {
  if (section === "entity") return <EntityAnalysis />;
  if (section === "local") return <LocalAnalysis />;
  return <KycAnalysis />;
}
