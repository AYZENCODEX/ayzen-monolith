/**
 * components/vault/vault-loading.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Loading state for vault screens. Replaces the old VaultLoadingIntro, which animated
 * a progress bar through a fixed list of made-up checkpoints ("Collecting
 * cookies", "Browser call successful") that bore no relation to what the app
 * was doing — a progress indicator should never claim work that isn't
 * happening.
 *
 * This shows what is actually true: something is loading, and roughly what
 * the screen will look like. Same props as before so call sites are drop-in:
 *   - `done` omitted → Suspense fallback; React unmounts it when the chunk arrives.
 *   - `done` provided → once it turns true, `onFinished` fires (once).
 */
import { useEffect, useRef } from "react";
import { Spinner } from "@/components/ui/spinner";
import { StatGridSkeleton, WidgetSkeleton } from "@/components/console";
import { cn } from "@/lib/utils";

export function VaultLoading({
  done,
  title = "Loading",
  onFinished,
  className,
}: {
  done?: boolean;
  title?: string;
  onFinished?: () => void;
  className?: string;
}) {
  const fired = useRef(false);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  useEffect(() => {
    if (done && !fired.current) {
      fired.current = true;
      onFinishedRef.current?.();
    }
  }, [done]);

  return (
    <div role="status" aria-busy="true" className={cn("space-y-5 font-ui", className)}>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4 motion-reduce:animate-none" aria-hidden="true" />
        <span>{title}…</span>
      </div>
      <StatGridSkeleton announce={false} />
      <WidgetSkeleton announce={false} />
    </div>
  );
}
