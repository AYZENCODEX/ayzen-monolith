/**
 * vault-shared-entity.tsx
 * ─────────────────────────────────────────────
 * Vault → Other → Shared → Entity detail.
 *
 * Route: /vault/shared/:entityType/:entityId
 *
 * Shows all shares for a single entity and lets the user:
 *  • Change permission (view / edit)
 *  • Toggle active / inactive
 *  • Revoke (delete) a share
 */
import { useState, useEffect, useCallback } from "react";
import { useParams, useLocation } from "wouter";
import {
  Share2, Loader2, Trash2, ChevronLeft,
  Eye, Pencil, Users, ToggleLeft, ToggleRight,
  CheckCircle2, XCircle,
} from "lucide-react";
import { customFetch } from "@workspace/api-client-react";
import { VaultSectionPage, VaultSectionEmptyState } from "@/components/layout/vault-sidebar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import type { SharedEntry } from "./vault-shared";
import { useModuleAwareNavigate } from "@/components/module-link";

export default function VaultSharedEntity() {
  const { entityType, entityId } = useParams<{ entityType: string; entityId: string }>();
  const navigate = useModuleAwareNavigate();
  const [allShares, setAllShares] = useState<SharedEntry[]>([]);
  const [shares, setShares] = useState<SharedEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const { toast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await customFetch<SharedEntry[]>("/api/vault-shares/sent");
      const all = Array.isArray(data) ? data : [];
      setAllShares(all);
      setShares(all.filter(s => String(s.entityId) === entityId && s.entityType === entityType));
    } catch {
      toast({ variant: "destructive", title: "Failed to load shares" });
    } finally {
      setLoading(false);
    }
  }, [entityType, entityId, toast]);

  useEffect(() => { load(); }, [load]);

  const entityLabel = shares[0]?.entityLabel ?? allShares.find(
    s => String(s.entityId) === entityId && s.entityType === entityType
  )?.entityLabel ?? `Entity #${entityId}`;

  const updatePermission = async (share: SharedEntry, permission: "view" | "edit") => {
    if (permission === share.permission) return;
    const prev = share.permission;
    setBusyId(share.id);
    setShares(p => p.map(s => s.id === share.id ? { ...s, permission } : s));
    try {
      await customFetch(`/api/vault-shares/${share.id}`, { method: "PATCH", body: JSON.stringify({ permission }) });
      toast({ title: "Permission updated", description: `${share.sharedWithUsername} — ${permission === "edit" ? "Full access" : "Read-only"}` });
    } catch {
      setShares(p => p.map(s => s.id === share.id ? { ...s, permission: prev } : s));
      toast({ variant: "destructive", title: "Failed to update permission" });
    } finally {
      setBusyId(null);
    }
  };

  const toggleActive = async (share: SharedEntry, next: boolean) => {
    setBusyId(share.id);
    setShares(p => p.map(s => s.id === share.id ? { ...s, isActive: next } : s));
    try {
      await customFetch(`/api/vault-shares/${share.id}`, { method: "PATCH", body: JSON.stringify({ isActive: next }) });
      toast({ title: next ? "Access turned on" : "Access turned off", description: share.sharedWithUsername });
    } catch {
      setShares(p => p.map(s => s.id === share.id ? { ...s, isActive: !next } : s));
      toast({ variant: "destructive", title: "Failed to update" });
    } finally {
      setBusyId(null);
    }
  };

  const removeShare = async (share: SharedEntry) => {
    setBusyId(share.id);
    try {
      await customFetch(`/api/vault-shares/${share.id}`, { method: "DELETE" });
      setShares(p => p.filter(s => s.id !== share.id));
      toast({ title: "Share removed", description: share.sharedWithUsername });
      // If no shares left, go back
      if (shares.length <= 1) navigate("/vault/shared");
    } catch {
      toast({ variant: "destructive", title: "Failed to remove share" });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <VaultSectionPage
      title={entityLabel}
      description="Manage who has access to this entity"
      icon={Users}
      headerExtra={<button type="button" className="btn" onClick={() => navigate("/vault/shared")}>‹ Shared</button>}
    >
      {loading ? (
        <div className="card"><div className="row" style={{ padding: "14px 18px" }} role="status"><div className="g"><b>Loading…</b></div></div></div>
      ) : shares.length === 0 ? (
        <VaultSectionEmptyState
          icon={Share2}
          title="No active shares"
          note="All shares for this entity have been removed."
        />
      ) : (
        <div className="card">
          {shares.map(s => (
            <div key={s.id} style={{ padding: "14px 18px", borderBottom: "1px solid var(--line)", display: "grid", gap: 12 }}>
              <div className="row" style={{ padding: 0, border: 0 }}>
                <span className="mk">{(s.sharedWithUsername.trim().slice(0, 2) || "··").toUpperCase()}</span>
                <div className="g"><b>{s.sharedWithUsername}</b><span>Since {new Date(s.createdAt).toLocaleDateString()}</span></div>
                <span className={`pill${s.isActive ? " ok" : ""}`}>{s.isActive ? "Active" : "Inactive"}</span>
              </div>

              {/* Controls row */}
              <div className="flex items-center gap-2 flex-wrap">
                {/* Permission selector — hidden for per-field shares, where access is
                    controlled field-by-field instead of one whole-entity level. */}
                {s.fieldPermissions ? (
                  <span className="pill" title={Object.entries(s.fieldPermissions).map(([f, p]) => `${f}: ${p}`).join(", ")}>
                    {Object.keys(s.fieldPermissions).length} field{Object.keys(s.fieldPermissions).length === 1 ? "" : "s"} shared
                  </span>
                ) : (
                  <Select
                    value={s.permission}
                    onValueChange={(v: "view" | "edit") => updatePermission(s, v)}
                    disabled={busyId === s.id}
                  >
                    <SelectTrigger className="font-mono text-[10px] h-8 w-[140px] flex-shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="view" className="font-mono text-xs">
                        <span className="flex items-center gap-1.5"><Eye className="w-3 h-3" /> Read-only</span>
                      </SelectItem>
                      <SelectItem value="edit" className="font-mono text-xs">
                        <span className="flex items-center gap-1.5"><Pencil className="w-3 h-3" /> Full access</span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                )}

                <button type="button" className="btn sm" disabled={busyId === s.id} onClick={() => toggleActive(s, !s.isActive)} aria-pressed={s.isActive}>
                  {s.isActive ? "Turn off" : "Turn on"}
                </button>

                <div style={{ flex: 1 }} />

                <button type="button" className="btn sm" disabled={busyId === s.id} onClick={() => removeShare(s)}>Revoke</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </VaultSectionPage>
  );
}
