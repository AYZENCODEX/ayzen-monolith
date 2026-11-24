/**
 * vault-enrollment-project-detail.tsx
 * ─────────────────────────────────────────────
 * Enrollment → Project → [project detail]: shows all vault entities enrolled
 * in a specific project. Each entity card is clickable → entity detail page.
 */
import { useEffect, useState, useCallback } from "react";
import { useLocation, useParams } from "wouter";
import {
  FolderGit2, Shield, Loader2, ChevronRight,
  ChevronLeft, Activity, CheckCircle2, XCircle,
  Users, AlertCircle,
} from "lucide-react";
import { customFetch } from "@workspace/api-client-react";
import { VaultSectionPage, VaultSectionEmptyState } from "@/components/layout/vault-sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useModuleAwareNavigate } from "@/components/module-link";

interface EnrolledEntity {
  id: number;
  project_name: string;
  category: string;
  entity_serial: string | null;
  status: string;
  twitter_username: string | null;
  discord_username: string | null;
  telegram_username: string | null;
  enrollment_status: string;
}

interface ProjectInfo {
  id: number;
  name: string;
  category: string | null;
  status: string | null;
  enrolled_count: number;
}

const STATUS_BADGE: Record<string, string> = {
  active:       "text-emerald-400 border-emerald-400/30 bg-emerald-400/5",
  completed:    "text-amber-400 border-amber-400/30 bg-amber-400/5",
  disqualified: "text-red-400 border-red-400/30 bg-red-400/5",
  banned:       "text-red-500 border-red-500/30 bg-red-500/5",
  cancelled:    "text-muted-foreground/40 border-border/30",
};

function entitySub(e: EnrolledEntity): string {
  const parts: string[] = [e.category];
  if (e.twitter_username) parts.push(`@${e.twitter_username}`);
  else if (e.discord_username) parts.push(e.discord_username);
  else if (e.telegram_username) parts.push(`@${e.telegram_username}`);
  if (e.entity_serial) parts.push(e.entity_serial);
  return parts.join(" · ");
}

export default function VaultEnrollmentProjectDetail() {
  const params = useParams<{ id: string }>();
  const projectId = Number(params.id);
  const navigate = useModuleAwareNavigate();

  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [entities, setEntities] = useState<EnrolledEntity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(false);
    try {
      // Load project info + enrolled entities in parallel
      const [projects, ents] = await Promise.all([
        customFetch<ProjectInfo[]>("/api/projects/enrolled"),
        customFetch<EnrolledEntity[]>(`/api/projects/${projectId}/enrolled-entities`),
      ]);
      const proj = Array.isArray(projects)
        ? projects.find(p => p.id === projectId) ?? null
        : null;
      setProject(proj);
      setEntities(Array.isArray(ents) ? ents : []);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  return (
    <VaultSectionPage
      title={project?.name ?? "Project"}
      description="Entities enrolled in this project — click to view details"
      icon={FolderGit2}
    >
      <button type="button" className="back" onClick={() => navigate("/vault/enrollment/project")}>‹ All projects</button>

      {loading ? (
        <div className="card"><div className="row" style={{ padding: "14px 18px" }} role="status"><div className="g"><b>Loading…</b></div></div></div>
      ) : error ? (
        <div className="card">
          <div className="row" style={{ padding: "18px" }} role="alert">
            <div className="g"><b>Failed to load project</b><span>Check your connection and try again.</span></div>
            <button type="button" className="btn sm" onClick={load}>Retry</button>
          </div>
        </div>
      ) : (
        <div className="stack">
          {project && (
            <div className="kpis">
              <div className="kpi" style={{ ["--c" as string]: "var(--ac)" }}>
                <label>Status</label><strong style={{ fontSize: 22 }}>{project.status ?? "active"}</strong><small>{project.category ?? "Uncategorized"}</small>
              </div>
              <div className="kpi" style={{ ["--c" as string]: "var(--ac)" }}>
                <label>Enrolled</label><strong>{project.enrolled_count}</strong><small>{project.enrolled_count === 1 ? "entity" : "entities"}</small>
              </div>
            </div>
          )}

          {entities.length === 0 ? (
            <VaultSectionEmptyState
              icon={Users}
              title="No entities enrolled"
              note="Enroll vault entities into this project to see them here."
            />
          ) : (
            <div className="card">
              <div className="tool">
                <span className="mono" style={{ flex: 1, fontSize: 11, color: "var(--mu)", letterSpacing: ".08em", textTransform: "uppercase" }}>
                  {entities.length} enrolled {entities.length === 1 ? "entity" : "entities"}
                </span>
              </div>
              {entities.map(entity => {
                const name = entity.project_name || `Entity #${entity.id}`;
                const tone = entity.enrollment_status === "active" ? " ok" : entity.enrollment_status === "completed" ? " warn" : " bad";
                const open = () => navigate(`/vault/entity/${entity.id}`);
                return (
                  <div key={entity.id} className="row go" role="link" tabIndex={0} onClick={open}
                    onKeyDown={(e) => { if (e.key === "Enter") open(); }} style={{ padding: "14px 18px", cursor: "pointer" }}>
                    <span className="mk">{(name.trim().slice(0, 2) || "··").toUpperCase()}</span>
                    <div className="g"><b>{name}</b><span>{entitySub(entity)}</span></div>
                    <span className={`pill${tone}`}>{entity.enrollment_status}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </VaultSectionPage>
  );
}
