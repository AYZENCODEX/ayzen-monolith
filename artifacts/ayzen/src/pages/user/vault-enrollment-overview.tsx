/**
 * vault-enrollment-overview.tsx
 * ─────────────────────────────────────────────
 * Enrollment → Overview: roll-up of every vault entity that is enrolled in
 * at least one project. Shows a summary dashboard bar at the top, then
 * individual entity cards — click any card to open the entity detail page.
 */
import { useEffect, useState, useCallback } from "react";
import { useLocation } from "wouter";
import {
  LayoutDashboard, Shield, FolderGit2,
  TrendingUp, Users, CheckCircle2, Activity,
} from "lucide-react";
import { useListVaultEntries, customFetch } from "@workspace/api-client-react";
import { VaultSectionPage, VaultSectionEmptyState } from "@/components/layout/vault-sidebar";
import { VaultLoading } from "@/components/vault/vault-loading";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useModuleAwareNavigate } from "@/components/module-link";

type EntryAny = any;

interface LeaderboardRow {
  vaultEntryId: number;
  totalProjects: number;
  activeProjects: number;
  completedProjects: number;
  totalReward: number;
}

export default function VaultEnrollmentOverview() {
  const navigate = useModuleAwareNavigate();
  const { data, isLoading } = useListVaultEntries();
  const entries: EntryAny[] = (data as EntryAny[] | undefined) ?? [];
  const [lb, setLb] = useState<LeaderboardRow[]>([]);
  const [lbLoading, setLbLoading] = useState(true);

  const loadLb = useCallback(async () => {
    setLbLoading(true);
    try {
      const rows = await customFetch<LeaderboardRow[]>("/api/projects/entity-leaderboard");
      setLb(Array.isArray(rows) ? rows : []);
    } catch {
      setLb([]);
    } finally {
      setLbLoading(false);
    }
  }, []);

  useEffect(() => { loadLb(); }, [loadLb]);

  const loading = isLoading || lbLoading;

  // Build map for fast lookup
  const lbMap = new Map<number, LeaderboardRow>(lb.map(r => [r.vaultEntryId, r]));

  // Only show entities that are actually enrolled somewhere
  const enrolled = entries.filter(e => (lbMap.get(e.id)?.totalProjects ?? 0) > 0);
  const notEnrolled = entries.length - enrolled.length;

  // Dashboard stats
  const totalEnrolled = enrolled.length;
  const totalProjects = lb.reduce((s, r) => s + r.totalProjects, 0);
  const totalActive = lb.reduce((s, r) => s + r.activeProjects, 0);
  const totalCompleted = lb.reduce((s, r) => s + r.completedProjects, 0);

  return (
    <VaultSectionPage
      title="Enrollment"
      description="All enrolled entities — click any card to view details"
      icon={LayoutDashboard}
    >
      {loading ? (
        <VaultLoading title="Loading enrollment overview" done={!loading} />
      ) : (
        <div className="space-y-5">
          {/* Dashboard summary */}
          <div className="kpis">
            {([
              ["Enrolled entities", totalEnrolled], ["Total enrollments", totalProjects],
              ["Active", totalActive], ["Completed", totalCompleted],
            ] as const).map(([label, value]) => (
              <div key={label} className="kpi" style={{ ["--c" as string]: "var(--ac)" }}>
                <label>{label}</label><strong>{value}</strong><small>{" "}</small>
              </div>
            ))}
          </div>

          {enrolled.length === 0 ? (
            <VaultSectionEmptyState
              icon={Shield}
              title="No enrolled entities yet"
              note={entries.length === 0
                ? "Add entities to your vault first, then enroll them into projects."
                : `You have ${entries.length} ${entries.length === 1 ? "entity" : "entities"} — enroll them into projects to see them here.`}
            />
          ) : (
            <>
              {notEnrolled > 0 && (
                <p className="mono" style={{ fontSize: 11, color: "var(--di)" }}>
                  {notEnrolled} {notEnrolled === 1 ? "entity" : "entities"} not yet enrolled — showing enrolled only
                </p>
              )}
              <div className="card">
                {enrolled.map(e => {
                  const row = lbMap.get(e.id);
                  const name = e.projectName || `Entity #${e.id}`;
                  const open = () => navigate(`/vault/entity/${e.id}`);
                  return (
                    <div key={e.id} className="row go" role="link" tabIndex={0} onClick={open}
                      onKeyDown={(ev) => { if (ev.key === "Enter") open(); }} style={{ padding: "14px 18px", cursor: "pointer" }}>
                      <span className="mk">{(name.trim().slice(0, 2) || "··").toUpperCase()}</span>
                      <div className="g">
                        <b>{name}</b>
                        <span>{e.entitySerial ?? ""}{e.twitterUsername ? ` · @${e.twitterUsername}` : ""}</span>
                      </div>
                      {(row?.activeProjects ?? 0) > 0 && <span className="pill ok">{row!.activeProjects} active</span>}
                      <span className="pill">{row?.totalProjects ?? 0} project{(row?.totalProjects ?? 0) === 1 ? "" : "s"}</span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </VaultSectionPage>
  );
}
