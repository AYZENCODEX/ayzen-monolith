import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { useModuleAccounts } from "@/lib/module-accounts-api";

/**
 * W1-P1 (req 1): shows the user's id in one module (e.g. SYL-000001), click to copy.
 * Renders nothing while loading, on error, or when the user has no account in that module,
 * so it can never block or clutter the sidebar.
 */
export function ModuleUidBadge({ moduleId, className = "" }: { moduleId: string; className?: string }) {
  const { data } = useModuleAccounts();
  const [copied, setCopied] = useState(false);
  const uid = data?.find((m) => m.module === moduleId)?.moduleUid;
  if (!uid) return null;
  return (
    <button
      type="button"
      data-testid="module-uid-badge"
      title="Your ID in this module — click to copy"
      onClick={() => {
        void navigator.clipboard?.writeText(uid).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }).catch(() => {});
      }}
      className={"flex w-full items-center gap-2 rounded-lg border border-sidebar-border px-2.5 py-1 text-[11px] font-mono text-muted-foreground hover:border-primary/40 hover:text-primary transition-colors " + className}
    >
      <span className="flex-1 text-left tracking-wider">{uid}</span>
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3 opacity-50" />}
    </button>
  );
}
