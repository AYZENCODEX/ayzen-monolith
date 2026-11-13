/**
 * components/console/page-header.tsx
 * Consistent page title block: optional breadcrumb trail, eyebrow, title,
 * description and a right-aligned action slot.
 */
import type { ReactNode } from "react";
import { Link } from "wouter";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface Crumb { label: string; href?: string }

export function PageHeader({
  eyebrow, title, description, actions, breadcrumbs, className,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumbs?: readonly Crumb[];
  className?: string;
}) {
  return (
    <header className={cn("space-y-3 font-ui", className)}>
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav aria-label="Breadcrumb">
          <ol className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            {breadcrumbs.map((crumb, i) => {
              const last = i === breadcrumbs.length - 1;
              return (
                <li key={`${crumb.label}-${i}`} className="flex items-center gap-1">
                  {crumb.href && !last ? (
                    <Link href={crumb.href} className="rounded transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                      {crumb.label}
                    </Link>
                  ) : (
                    <span aria-current={last ? "page" : undefined} className={cn(last && "text-foreground")}>{crumb.label}</span>
                  )}
                  {!last && <ChevronRight className="size-3 text-muted-foreground/50" aria-hidden="true" />}
                </li>
              );
            })}
          </ol>
        </nav>
      )}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          {eyebrow && <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary/80">{eyebrow}</p>}
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
          {description && <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
