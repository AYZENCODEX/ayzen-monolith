/**
 * components/console/loaders.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Spinner-based loading affordances. Rule of thumb used across the console:
 *   - Page / panel content  → skeletons (skeletons.tsx), never a spinner
 *   - Pending user action   → LoadingButton / InlineLoader
 *   - App boot / redirects  → FullScreenLoader
 * Nothing here fakes progress: a spinner means "working", with no percentage.
 */
import * as React from "react";
import { Spinner } from "@/components/ui/spinner";
import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function FullScreenLoader({ label = "Loading" }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background font-ui text-muted-foreground"
    >
      <Spinner className="size-6 text-primary motion-reduce:animate-none" aria-hidden="true" />
      <span className="text-sm">{label}…</span>
    </div>
  );
}

export function InlineLoader({ label = "Loading", className }: { label?: string; className?: string }) {
  return (
    <div role="status" aria-live="polite" className={cn("flex items-center gap-2 font-ui text-sm text-muted-foreground", className)}>
      <Spinner className="size-4 motion-reduce:animate-none" aria-hidden="true" />
      <span>{label}…</span>
    </div>
  );
}

export interface LoadingButtonProps extends ButtonProps {
  loading?: boolean;
  /** Replaces the label while loading, e.g. "Saving". Defaults to the original children. */
  loadingText?: string;
}

/**
 * Button that blocks re-submission while pending and keeps its width stable
 * (spinner takes the icon slot) so the layout does not jump.
 */
export const LoadingButton = React.forwardRef<HTMLButtonElement, LoadingButtonProps>(
  ({ loading = false, loadingText, disabled, children, ...props }, ref) => (
    <Button ref={ref} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
      {loading && <Spinner className="motion-reduce:animate-none" aria-hidden="true" />}
      {loading && loadingText ? loadingText : children}
    </Button>
  ),
);
LoadingButton.displayName = "LoadingButton";
