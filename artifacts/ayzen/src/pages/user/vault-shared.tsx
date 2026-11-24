/**
 * vault-shared.tsx
 * ─────────────────────────────────────────────
 * Vault → Other → Shared.
 *
 * Groups all outgoing shares by entity. Each entity card is clickable →
 * navigates to /vault/shared/entity/:entityId where you can manage all
 * shares for that specific entity.
 */
import { useState, useEffect, useCallback } from "react";
import { Link } from "wouter";
import { customFetch } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

export interface SharedEntry {
  id: number;
  entityType: string;
  entityId: number;
  entityLabel: string;
  sharedWithUserId: number;
  sharedWithUsername: string;
  permission: "view" | "edit";
  fieldPermissions: Record<string, "view" | "edit"> | null;
  isActive: boolean;
  createdAt: string;
}

interface EntityGroup {
  entityType: string;
  entityId: number;
  entityLabel: string;
  shares: SharedEntry[];
}

function groupByEntity(shares: SharedEntry[]): EntityGroup[] {
  const map = new Map<string, EntityGroup>();
  for (const s of shares) {
    const key = `${s.entityType}:${s.entityId}`;
    if (!map.has(key)) {
      map.set(key, { entityType: s.entityType, entityId: s.entityId, entityLabel: s.entityLabel, shares: [] });
    }
    map.get(key)!.shares.push(s);
  }
  return [...map.values()].sort((a, b) => a.entityLabel.localeCompare(b.entityLabel));
}

export default function VaultShared() {
  const [shares, setShares] = useState<SharedEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await customFetch<SharedEntry[]>("/api/vault-shares/sent");
      setShares(Array.isArray(data) ? data : []);
    } catch {
      toast({ variant: "destructive", title: "Failed to load shared entities" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const groups = groupByEntity(shares);

  return (
    <div className="stack t-brass">
      <div className="ph">
        <div>
          <div className="eb">Records · Shared</div>
          <h1>Shared</h1>
          <p>Entities you've shared — open one to manage who can see or edit it.</p>
        </div>
      </div>
      <div className="card">
        {loading && <div className="row" style={{ padding: "14px 18px" }} role="status"><div className="g"><b>Loading…</b></div></div>}
        {!loading && groups.length === 0 && (
          <div className="row" style={{ padding: "26px 18px", flexDirection: "column", alignItems: "flex-start", gap: 6 }}>
            <b style={{ fontWeight: 500 }}>Nothing shared yet</b>
            <span style={{ fontFamily: "var(--sans)" }}>Entities you share from the entity list appear here, grouped by entity.</span>
          </div>
        )}
        {groups.map((g) => {
          const editCount = g.shares.filter((s) => !s.fieldPermissions && s.permission === "edit").length;
          const fieldCount = g.shares.filter((s) => !!s.fieldPermissions).length;
          const viewCount = g.shares.length - editCount - fieldCount;
          const inactive = g.shares.filter((s) => !s.isActive).length;
          const sub = [
            `${g.shares.length} share${g.shares.length !== 1 ? "s" : ""}`,
            editCount > 0 && `${editCount} edit`, viewCount > 0 && `${viewCount} view`,
            fieldCount > 0 && `${fieldCount} per-field`, inactive > 0 && `${inactive} inactive`,
          ].filter(Boolean).join(" · ");
          return (
            <Link key={`${g.entityType}:${g.entityId}`} href={`/vault/shared/${g.entityType}/${g.entityId}`} className="row go" style={{ padding: "14px 18px" }}>
              <span className="mk">{(g.entityLabel.trim().slice(0, 2) || "··").toUpperCase()}</span>
              <div className="g"><b>{g.entityLabel}</b><span>{sub}</span></div>
              <span className="pill">{g.entityType}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
