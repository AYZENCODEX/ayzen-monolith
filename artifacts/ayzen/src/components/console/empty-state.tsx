/**
 * components/console/empty-state.tsx
 * "Nothing here yet" surface. Always explains what the thing is and offers the
 * one action that would populate it — an empty table with no next step is a
 * dead end.
 */
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function EmptyState({
  icon: Icon, title, description, action, className,
}: { icon: LucideIcon; title: string; description?: string; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 px-6 py-10 text-center font-ui", className)}>
      <span className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground ring-1 ring-border">
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description && <p className="mx-auto max-w-xs text-xs leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}
