/**
 * vault-enrollment-entity.tsx
 * ─────────────────────────────────────────────
 * Vault → Enrollment → Entity — now its own 3-item hierarchy in the Vault
 * sidebar (Entity Overview / Entity Ongoing / Entity Past — see ENROLL_ITEMS
 * in components/layout/vault-sidebar.tsx), replacing the old single-list
 * "Entity" page (pages/user/vault-enroll.tsx). One component, one dataset
 * (GET /projects/mine/enrolled-entities), three views selected by the
 * :view route param:
 *
 *   overview — every entity enrolled into at least one project
 *   ongoing  — entities with at least one project whose own lifecycle
 *              status (projects.status) is "active" or "paused"
 *   past     — entities with at least one project whose status is
 *              "completed" or "archived"
 *
 * An entity can show up under both Ongoing and Past if it has projects in
 * each bucket — that's expected, not a bug, since the split is per-project
 * status rather than a single flag on the entity.
 */
import { useEffect, useState, useCallback } from "react";
import { useParams, Link } from "wouter";
import { Shield, Loader2, Activity, History, LayoutDashboard } from "lucide-react";
import { customFetch } from "@workspace/api-client-react";
import { VaultSectionPage, VaultSectionEmptyState } from "@/components/layout/vault-sidebar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface EntityProjectRow {
  projectId: number;
  projectName: string;
  projectStatus: string | null;
  enrollmentStatus: string;
  enrolledAt: string;
}

interface EnrolledEntity {
  vaultEntryId: number;
  entityName: string | null;
  entitySerial: string | null;
  category: string | null;
  projects: EntityProjectRow[];
  hasOngoing: boolean;
  hasPast: boolean;
}

const ONGOING_STATUSES = new Set(["active", "paused"]);
const PAST_STATUSES = new Set(["completed", "archived"]);

type View = "overview" | "ongoing" | "past";

const VIEW_META: Record<View, { title: string; description: string; icon: React.ElementType; empty: string; note: string }> = {
  overview: {
    title: "Entity — Overview",
    description: "Every entity enrolled into at least one project",
    icon: LayoutDashboard,
    empty: "No enrolled entities yet",
    note: "Enroll an entity into a project — it'll show up here.",
  },
  ongoing: {
    title: "Entity — Ongoing",
    description: "Entities with at least one project that's still active or paused",
    icon: Activity,
    empty: "No entities in an ongoing project",
    note: "Once one of an entity's projects is active or paused, it'll show up here.",
  },
  past: {
    title: "Entity — Past",
    description: "Entities with at least one project that's completed or archived",
    icon: History,
    empty: "No entities with a past project yet",
    note: "Once one of an entity's projects wraps up (completed/archived), it'll show up here.",
  },
};

function useAuthedEntities() {
  const [entities, setEntities] = useState<EnrolledEntity[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await customFetch<EnrolledEntity[]>("/api/projects/mine/enrolled-entities");
      setEntities(Array.isArray(rows) ? rows : []);
    } catch {
      setEntities([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return { entities, loading };
}

export default function VaultEnrollmentEntity() {
  const params = useParams<{ view?: string }>();
  const view: View = params.view === "ongoing" || params.view === "past" ? (params.view as View) : "overview";
  const meta = VIEW_META[view];
  const { entities, loading } = useAuthedEntities();

  const filtered = entities.filter(e =>
    view === "overview" ? true : view === "ongoing" ? e.hasOngoing : e.hasPast
  );

  return (
    <VaultSectionPage title={meta.title} description={meta.description} icon={meta.icon}>
      {loading ? (
        <div className="card"><div className="row" style={{ padding: "14px 18px" }} role="status"><div className="g"><b>Loading…</b></div></div></div>
      ) : filtered.length === 0 ? (
        <VaultSectionEmptyState icon={meta.icon} title={meta.empty} note={meta.note} />
      ) : (
        <div className="card">
          {filtered.map(e => {
            const shownProjects = view === "overview"
              ? e.projects
              : e.projects.filter(p =>
                  view === "ongoing" ? ONGOING_STATUSES.has(p.projectStatus ?? "active") : PAST_STATUSES.has(p.projectStatus ?? "active")
                );
            const name = e.entityName || `Entity #${e.vaultEntryId}`;
            return (
              <div key={e.vaultEntryId} style={{ borderBottom: "1px solid var(--line)" }}>
                <div className="row" style={{ padding: "14px 18px", borderBottom: 0 }}>
                  <span className="mk">{(name.trim().slice(0, 2) || "··").toUpperCase()}</span>
                  <div className="g"><b>{name}</b><span>{e.entitySerial ?? ""}</span></div>
                  <span className="pill ok">{e.projects.length} project{e.projects.length !== 1 ? "s" : ""}</span>
                </div>
                {shownProjects.length > 0 && (
                  <div style={{ padding: "0 18px 14px 18px", display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {shownProjects.map(p => (
                      <Link key={p.projectId} href={`/vault/enrollment/project/${p.projectId}`}
                        className={`pill${ONGOING_STATUSES.has(p.projectStatus ?? "active") ? " ok" : ""}`}>
                        {p.projectName} · {p.projectStatus ?? "active"}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </VaultSectionPage>
  );
}
