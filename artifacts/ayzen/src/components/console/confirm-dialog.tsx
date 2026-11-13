/**
 * components/console/confirm-dialog.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Promise-based confirmation, replacing window.confirm (unstyled, blocks the
 * thread, impossible to test, and inconsistent with the rest of the UI).
 *
 *   const { confirm, dialog } = useConfirm();
 *   …
 *   if (!(await confirm({ title: "Delete entity?", tone: "danger", confirmLabel: "Delete" }))) return;
 *   …
 *   return <>{…}{dialog}</>;
 *
 * Built on the existing Radix AlertDialog, so focus trapping, Escape-to-cancel
 * and aria-labelling come for free.
 */
import { useCallback, useRef, useState, type ReactNode } from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ConfirmOptions {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** "danger" styles the confirm action as destructive. */
  tone?: "default" | "danger";
}

export function useConfirm() {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((value: boolean) => void) | null>(null);

  const settle = useCallback((value: boolean) => {
    resolver.current?.(value);
    resolver.current = null;
    setOptions(null);
  }, []);

  const confirm = useCallback((next: ConfirmOptions) => {
    // A second call while one is open cancels the first rather than leaking its promise.
    resolver.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setOptions(next);
    });
  }, []);

  const dialog = (
    <AlertDialog open={options !== null} onOpenChange={(open) => { if (!open) settle(false); }}>
      <AlertDialogContent className="font-ui">
        <AlertDialogHeader>
          <AlertDialogTitle>{options?.title}</AlertDialogTitle>
          {options?.description && <AlertDialogDescription>{options.description}</AlertDialogDescription>}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => settle(false)}>{options?.cancelLabel ?? "Cancel"}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => settle(true)}
            className={cn(options?.tone === "danger" && buttonVariants({ variant: "destructive" }))}
          >
            {options?.confirmLabel ?? "Confirm"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { confirm, dialog };
}
