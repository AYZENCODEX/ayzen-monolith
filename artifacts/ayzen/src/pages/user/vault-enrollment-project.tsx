/**
 * vault-enrollment-project.tsx
 * ─────────────────────────────────────────────
 * Enrollment → Project: lists all projects the user has entities enrolled in.
 * Click a project card to navigate to its dedicated detail page
 * (/vault/enrollment/project/:id) which shows the enrolled entities.
 */
import { useEffect, useState, useCallback } from "react";
import { useLocation } from "wouter";
import {
  FolderGit2, Loader2, ChevronRight,
  CheckCircle2, Activity, XCircle, Users,
} from "lucide-react";
import { customFetch } from "@workspace/api-client-react";
import { VaultSectionPage, VaultSectionEmptyState } from "@/components/layout/vault-sidebar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useModuleAwareNavigate } from "@/components/module-link";

interface EnrolledProject {
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

const STATUS_ICON: Record<string, React.ElementType> = {
  active:    Activity,
  completed: CheckCircle2,
  cancelled: XCircle,
};

export default function VaultEnrollmentProject() {
  const navigate = useModuleAwareNavigate();
  const [projects, setProjects] = useState<EnrolledProject[]>([]);
  const [loading, setLoading] = useState(true);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await customFetch<EnrolledProject[]>("/api/projects/enrolled");
      setProjects(Array.isArray(rows) ? rows : []);
    } catch {
      setProjects([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  return (
    <VaultSectionPage
      title="Projects"
      description="Projects your entities are enrolled in — click to view enrolled entities"
      icon={FolderGit2}
    >
      {loading ? (
        <div className="card"><div className="row" style={{ padding: "14px 18px" }} role="status"><div className="g"><b>Loading…</b></div></div></div>
      ) : projects.length === 0 ? (
        <VaultSectionEmptyState
          icon={FolderGit2}
          title="No project enrollments"
          note="Enroll your entities into projects to see them here."
        />
      ) : (
        <div className="card">
          {projects.map(project => {
            const statusKey = project.status ?? "active";
            const tone = statusKey === "active" ? " ok" : statusKey === "completed" ? " warn" : statusKey === "disqualified" || statusKey === "banned" ? " bad" : "";
            const open = () => navigate(`/vault/enrollment/project/${project.id}`);
            return (
              <div key={project.id} className="row go" role="link" tabIndex={0} onClick={open}
                onKeyDown={(e) => { if (e.key === "Enter") open(); }} style={{ padding: "14px 18px", cursor: "pointer" }}>
                <span className="mk">{(project.name.trim().slice(0, 2) || "··").toUpperCase()}</span>
                <div className="g"><b>{project.name}</b><span>{project.category ?? "Uncategorized"} · {project.enrolled_count} enrolled</span></div>
                <span className={`pill${tone}`}>{statusKey}</span>
              </div>
            );
          })}
        </div>
      )}
    </VaultSectionPage>
  );
}
