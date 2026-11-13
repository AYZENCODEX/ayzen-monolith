/**
 * components/sylo/widgets.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Data-bound widgets shared by the Console and the section Home pages. Each
 * owns its query and renders all four states (loading / error / empty / data)
 * through QueryBoundary, so a failed request never reads as "no data".
 */
import { Link } from "wouter";
import { formatDistanceToNow } from "date-fns";
import {
  Ban, CheckCircle2, Clock, Coins, History, KeyRound, ShieldAlert, ShieldCheck, TrendingDown, TrendingUp, Wallet,
} from "lucide-react";
import {
  EmptyState, ListSkeleton, QueryBoundary, StatGridSkeleton, StatTile, Widget, WidgetLink,
  type Tone,
} from "@/components/console";
import {
  useKycSummary, useLocalSummary, useVaultActivity, useVaultAnalytics, useVaultHealth,
  type HealthSeverity,
} from "@/hooks/use-sylo-data";
import { formatPct, formatSignedUsd, formatUsd } from "@/lib/format-money";
import { accountPath } from "@/lib/sylo-routes";
import { cn } from "@/lib/utils";

const GRID = "grid grid-cols-2 gap-3 lg:grid-cols-4";
const ERROR_BOX = "rounded-xl border border-border bg-card";

const pnlTone = (n: number): Tone => (n > 0 ? "success" : n < 0 ? "danger" : "neutral");

/* ─── Stat grids ─────────────────────────────────────────────────────────── */

export function EntityStatGrid() {
  const query = useVaultAnalytics();
  return (
    <QueryBoundary query={query} skeleton={<StatGridSkeleton />} errorClassName={ERROR_BOX}>
      {({ overview: o }) => (
        <div className={GRID}>
          <StatTile label="Entities" value={o.totalEntries} icon={KeyRound} tone="primary" />
          <StatTile label="Total worth" value={formatUsd(o.totalVaultWorth)} icon={Wallet} hint={`Cost basis ${formatUsd(o.totalBuyValue)}`} />
          <StatTile
            label="Net P&L" value={formatSignedUsd(o.netPnl)} tone={pnlTone(o.netPnl)}
            icon={o.netPnl < 0 ? TrendingDown : TrendingUp}
          />
          <StatTile
            label="2FA coverage" value={formatPct(o.twofaCoveragePct, 0)} icon={ShieldCheck}
            tone={o.twofaCoveragePct >= 90 ? "success" : o.twofaCoveragePct >= 60 ? "warning" : "danger"}
            hint={`Avg. score ${o.avgScore.toFixed(0)}`}
          />
        </div>
      )}
    </QueryBoundary>
  );
}

export function LocalStatGrid() {
  const query = useLocalSummary();
  return (
    <QueryBoundary query={query} skeleton={<StatGridSkeleton />} errorClassName={ERROR_BOX}>
      {(s) => (
        <div className={GRID}>
          <StatTile label="Accounts" value={s.total} icon={KeyRound} tone="primary" />
          <StatTile label="Total worth" value={formatUsd(s.totalWorth)} icon={Wallet} hint={`Cost basis ${formatUsd(s.totalBuy)}`} />
          <StatTile label="Net P&L" value={formatSignedUsd(s.netPnl)} tone={pnlTone(s.netPnl)} icon={s.netPnl < 0 ? TrendingDown : TrendingUp} />
          <StatTile label="Banned" value={s.banned} icon={Ban} tone={s.banned > 0 ? "danger" : "neutral"} hint={`${s.byCategory.length} categories`} />
        </div>
      )}
    </QueryBoundary>
  );
}

export function KycStatGrid() {
  const query = useKycSummary();
  return (
    <QueryBoundary query={query} skeleton={<StatGridSkeleton />} errorClassName={ERROR_BOX}>
      {(s) => (
        <div className={GRID}>
          <StatTile label="Entries" value={s.total} icon={ShieldCheck} tone="primary" />
          <StatTile label="Paid" value={`${s.paid} / ${s.total}`} icon={CheckCircle2} tone={s.unpaid === 0 && s.total > 0 ? "success" : "neutral"} hint={`${s.unpaid} unpaid`} />
          <StatTile label="Total worth" value={formatUsd(s.totalWorth)} icon={Coins} hint={`Cost basis ${formatUsd(s.totalBuy)}`} />
          <StatTile label="Net P&L" value={formatSignedUsd(s.netPnl)} tone={pnlTone(s.netPnl)} icon={s.netPnl < 0 ? TrendingDown : TrendingUp} />
        </div>
      )}
    </QueryBoundary>
  );
}

/* ─── Needs attention (entity health) ────────────────────────────────────── */

const SEVERITY_BADGE: Record<HealthSeverity, string> = {
  alert: "bg-danger-muted text-danger ring-danger/25",
  warn: "bg-warning-muted text-warning ring-warning/25",
  flag: "bg-info-muted text-info ring-info/25",
};

export function AttentionWidget({ className }: { className?: string }) {
  const query = useVaultHealth();
  return (
    <Widget
      className={className}
      title="Needs attention"
      description="Entities that tripped a health rule"
      padded={false}
      footer={<WidgetLink href={accountPath("entity", "management")}>Review entities</WidgetLink>}
    >
      <QueryBoundary
        query={query}
        skeleton={<div className="p-4"><ListSkeleton rows={4} /></div>}
        isEmpty={(r) => r.flaggedEntries.length === 0}
        empty={<EmptyState icon={ShieldCheck} title="All clear" description="No entity currently breaks a health rule." />}
      >
        {(report) => (
          <div>
            <dl className="grid grid-cols-2 gap-px border-b border-border/60 bg-border/60 sm:grid-cols-4">
              {([
                ["Low score", report.counts.lowScore],
                ["No 2FA", report.counts.missing2fa],
                ["Inactive 30d", report.counts.inactive30d],
                ["Banned / suspended", report.counts.bannedOrSuspended],
              ] as const).map(([label, count]) => (
                <div key={label} className="bg-card px-4 py-3">
                  <dt className="text-[11px] text-muted-foreground">{label}</dt>
                  <dd className={cn("text-lg font-semibold tabular-nums", count > 0 ? "text-foreground" : "text-muted-foreground/60")}>{count}</dd>
                </div>
              ))}
            </dl>
            <ul className="divide-y divide-border/60">
              {report.flaggedEntries.slice(0, 5).map((e) => {
                const worst = e.hits.some((h) => h.severity === "alert") ? "alert" : e.hits.some((h) => h.severity === "warn") ? "warn" : "flag";
                return (
                  <li key={e.id}>
                    <Link
                      href={`/vault/entity/${e.id}`}
                      className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <ShieldAlert className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">{e.projectName}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {e.entitySerial ?? `#${e.id}`} · {e.hits[0]?.message ?? "Flagged"}
                          {e.hits.length > 1 ? ` (+${e.hits.length - 1})` : ""}
                        </span>
                      </span>
                      <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ring-1", SEVERITY_BADGE[worst])}>{worst}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </QueryBoundary>
    </Widget>
  );
}

/* ─── Recent activity ────────────────────────────────────────────────────── */

const humanise = (action: string): string => {
  const text = action.replace(/[_.-]+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
};

export function ActivityWidget({ limit = 6, className }: { limit?: number; className?: string }) {
  const query = useVaultActivity(limit);
  return (
    <Widget className={className} title="Recent activity" description="Latest changes across your entities">
      <QueryBoundary
        query={query}
        skeleton={<ListSkeleton rows={Math.min(limit, 5)} />}
        isEmpty={(p) => p.entries.length === 0}
        empty={<EmptyState icon={History} title="No activity yet" description="Changes you make to entities will appear here." />}
      >
        {(page) => (
          <ol className="space-y-3.5">
            {page.entries.map((row) => (
              <li key={row.id} className="flex items-start gap-3">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground ring-1 ring-border">
                  <Clock className="size-3.5" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-foreground">
                    {humanise(row.action)}
                    {row.entitySerial && (
                      <>
                        {" · "}
                        <Link href={`/vault/entity/${row.vaultEntryId}`} className="font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                          {row.entitySerial}
                        </Link>
                      </>
                    )}
                  </p>
                  {row.detail && <p className="truncate text-xs text-muted-foreground">{row.detail}</p>}
                </div>
                <time dateTime={row.createdAt} className="shrink-0 text-xs text-muted-foreground">
                  {formatDistanceToNow(new Date(row.createdAt), { addSuffix: true })}
                </time>
              </li>
            ))}
          </ol>
        )}
      </QueryBoundary>
    </Widget>
  );
}
