/**
 * components/console/skeletons.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Skeletons that mirror the real layout (same radii, paddings and row heights
 * as StatTile / Widget / table rows) so content swapping in does not shift the
 * page. Every composite is a labelled `role="status"` region for assistive
 * tech, and respects `prefers-reduced-motion`.
 */
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** A single neutral placeholder block. */
export function Bone({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <Skeleton aria-hidden="true" style={style} className={cn("bg-muted motion-reduce:animate-none", className)} />;
}

/**
 * Announces itself once. Composites nested inside another skeleton pass
 * `announce={false}` so a screen reader hears a single "Loading …", not one
 * per child region.
 */
function Region({
  label, announce = true, className, children,
}: { label: string; announce?: boolean; className?: string; children: React.ReactNode }) {
  if (!announce) return <div className={className}>{children}</div>;
  return (
    <div role="status" aria-busy="true" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

export function StatTileSkeleton() {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-elevation-1">
      <div className="flex items-center justify-between">
        <Bone className="h-3 w-20" />
        <Bone className="h-7 w-7 rounded-md" />
      </div>
      <Bone className="mt-4 h-7 w-28" />
      <Bone className="mt-3 h-3 w-24" />
    </div>
  );
}

export function StatGridSkeleton({ count = 4, announce = true }: { count?: number; announce?: boolean }) {
  return (
    <Region label="Loading figures" announce={announce} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {Array.from({ length: count }, (_, i) => (
        <StatTileSkeleton key={i} />
      ))}
    </Region>
  );
}

export function TableSkeleton({ rows = 6, cols = 4, announce = true }: { rows?: number; cols?: number; announce?: boolean }) {
  return (
    <Region label="Loading rows" announce={announce} className="divide-y divide-border/60">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex items-center gap-4 px-4 py-3">
          <Bone className="h-8 w-8 shrink-0 rounded-md" />
          {Array.from({ length: cols }, (_, c) => (
            <Bone key={c} className={cn("h-3.5", c === 0 ? "w-40" : "w-20", c > 1 && "hidden sm:block")} />
          ))}
        </div>
      ))}
    </Region>
  );
}

export function ChartSkeleton({ className, announce = true }: { className?: string; announce?: boolean }) {
  return (
    <Region label="Loading chart" announce={announce} className={cn("flex h-56 items-end gap-2 px-2", className)}>
      {[40, 62, 48, 78, 55, 90, 66, 72, 50, 84].map((h, i) => (
        <div key={i} aria-hidden="true" className="flex flex-1 items-end self-stretch">
          <Bone className="w-full rounded-b-none rounded-t-md" style={{ height: `${h}%` }} />
        </div>
      ))}
    </Region>
  );
}

export function ListSkeleton({ rows = 5, announce = true }: { rows?: number; announce?: boolean }) {
  return (
    <Region label="Loading list" announce={announce} className="space-y-3">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Bone className="h-8 w-8 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <Bone className="h-3 w-3/5" />
            <Bone className="h-3 w-2/5" />
          </div>
        </div>
      ))}
    </Region>
  );
}

export function WidgetSkeleton({ className, rows = 4, announce = true }: { className?: string; rows?: number; announce?: boolean }) {
  return (
    <Region label="Loading panel" announce={announce} className={cn("rounded-xl border border-border bg-card shadow-elevation-1", className)}>
      <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
        <Bone className="h-4 w-32" />
        <Bone className="h-6 w-16 rounded-md" />
      </div>
      <div className="p-4">
        <ListSkeleton rows={rows} announce={false} />
      </div>
    </Region>
  );
}

export function PageHeaderSkeleton({ announce = true }: { announce?: boolean }) {
  return (
    <Region label="Loading page" announce={announce} className="space-y-2">
      <Bone className="h-3 w-24" />
      <Bone className="h-7 w-64" />
      <Bone className="h-4 w-96 max-w-full" />
    </Region>
  );
}

/**
 * Route-level fallback (Suspense) — a page frame, not a spinner on a blank
 * screen, so navigating between lazy routes keeps the layout stable.
 */
export function PageSkeleton({ stats = 4, widgets = 2 }: { stats?: number; widgets?: number }) {
  return (
    <Region label="Loading page" className="space-y-6">
      <PageHeaderSkeleton announce={false} />
      <StatGridSkeleton count={stats} announce={false} />
      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: widgets }, (_, i) => (
          <WidgetSkeleton key={i} announce={false} />
        ))}
      </div>
    </Region>
  );
}
