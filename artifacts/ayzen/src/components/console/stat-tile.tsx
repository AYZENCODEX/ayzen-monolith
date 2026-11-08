/**
 * components/console/stat-tile.tsx
 * KPI tile. Colour carries meaning only through the semantic status tokens
 * (success / warning / danger / info) — never brand colours — so a red number
 * always means "bad", regardless of the active theme accent.
 */
import type { ReactNode } from "react";
import { Link } from "wouter";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { StatTileSkeleton } from "./skeletons";

export type Tone = "neutral" | "primary" | "success" | "warning" | "danger" | "info";

export const TONE_CHIP: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground ring-border",
  primary: "bg-primary/10 text-primary ring-primary/20",
  success: "bg-success-muted text-success ring-success/25",
  warning: "bg-warning-muted text-warning ring-warning/25",
  danger: "bg-danger-muted text-danger ring-danger/25",
  info: "bg-info-muted text-info ring-info/25",
};

const TONE_VALUE: Record<Tone, string> = {
  neutral: "text-foreground",
  primary: "text-foreground",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-info",
};

export interface StatTileProps {
  label: string;
  value: ReactNode;
  icon?: LucideIcon;
  tone?: Tone;
  /** Secondary line, e.g. "of 24 total" or a delta. */
  hint?: ReactNode;
  /** Makes the whole tile a link. */
  href?: string;
  loading?: boolean;
}

export function StatTile({ label, value, icon: Icon, tone = "neutral", hint, href, loading }: StatTileProps) {
  if (loading) return <StatTileSkeleton />;

  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        {Icon && (
          <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-md ring-1", TONE_CHIP[tone])}>
            <Icon className="size-3.5" aria-hidden="true" />
          </span>
        )}
      </div>
      <p className={cn("mt-3 text-2xl font-semibold tabular-nums tracking-tight", TONE_VALUE[tone])}>{value}</p>
      {hint && <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>}
    </>
  );

  const base = "block rounded-xl border border-border bg-card p-4 font-ui shadow-elevation-1";
  if (href) {
    return (
      <Link
        href={href}
        className={cn(base, "transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring")}
      >
        {body}
      </Link>
    );
  }
  return <div className={base}>{body}</div>;
}
