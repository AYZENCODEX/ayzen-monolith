/**
 * components/console/widget.tsx
 * Titled panel used for every dashboard module. Owns its own header, optional
 * footer link and padding so widgets line up on a grid without per-page CSS.
 */
import { useId, type ReactNode } from "react";
import { Link } from "wouter";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

export function Widget({
  title, description, action, footer, padded = true, className, children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  footer?: ReactNode;
  /** Set false for edge-to-edge content such as tables. */
  padded?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className={cn("flex flex-col rounded-xl border border-border bg-card font-ui shadow-elevation-1", className)}
    >
      <header className="flex items-start justify-between gap-3 border-b border-border/60 px-4 py-3">
        <div className="min-w-0">
          <h2 id={titleId} className="text-sm font-semibold text-foreground">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </header>
      <div className={cn("flex-1", padded && "p-4")}>{children}</div>
      {footer && <footer className="border-t border-border/60 px-4 py-2.5">{footer}</footer>}
    </section>
  );
}

/** Standard "View all →" footer link. */
export function WidgetLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 rounded text-xs font-medium text-primary transition-colors hover:text-primary/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {children} <ArrowRight className="size-3" aria-hidden="true" />
    </Link>
  );
}
