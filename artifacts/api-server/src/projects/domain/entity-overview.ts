/**
 * projects/domain/entity-overview.ts
 * Pure mapping for the per-entity overview and the entity leaderboard. No database, HTTP, or logging
 * dependencies. Moved unchanged from routes/projects.ts (PRJ-05). Row inputs are raw (snake_case) SQL rows.
 */

/** Empty overview returned when the ownership gate denies: same 200 shape the query returned for a non-owned id. */
export function emptyEntityOverview(vaultEntryId: number) {
  return {
    entity: null,
    vaultEntryId,
    projects: [],
    activity: [],
    summary: { totalProjects: 0, completedProjects: 0, ongoingProjects: 0, totalRoi: 0, totalProfit: 0, totalCost: 0 },
  };
}

export function buildEntityOverview(vaultEntryId: number, rows: any[], entityRows: any[], activityRows: any[]) {
  const projects = rows.map((r) => ({
    projectId: Number(r.project_id),
    projectName: r.project_name,
    projectType: r.project_type ?? "protocol",
    category: r.category,
    thumbnailUrl: r.thumbnail_url,
    totalTasks: Number(r.total_tasks),
    completedTasks: Number(r.completed_tasks),
    progress: Number(r.total_tasks) > 0 ? Math.round((Number(r.completed_tasks) / Number(r.total_tasks)) * 100) : 0,
    totalProfit: Number(r.total_profit),
    totalCost: Number(r.total_cost),
    roi: Number(r.total_profit) - Number(r.total_cost),
    enrollmentId: Number(r.enrollment_id),
    enrolledAt: r.enrolled_at,
    enrollmentStatus: (r.enrollment_status as string) ?? "active",
  }));
  const totalRoi = projects.reduce((s, p) => s + p.roi, 0);
  const totalProfit = projects.reduce((s, p) => s + p.totalProfit, 0);
  const totalCost = projects.reduce((s, p) => s + p.totalCost, 0);
  const completedProjects = projects.filter((p) => p.enrollmentStatus === "completed").length;
  const ongoingProjects = projects.length - completedProjects;
  const activity = activityRows.map((r) => ({ day: String(r.day), count: Number(r.count) }));
  return {
    entity: entityRows[0] ?? null,
    vaultEntryId,
    projects,
    activity,
    summary: { totalProjects: projects.length, completedProjects, ongoingProjects, totalRoi, totalProfit, totalCost },
  };
}

/** Entities ranked by ROI (highest first), with a 1-based rank. */
export function buildEntityLeaderboard(rows: any[]) {
  return rows
    .map((r) => ({
      vaultEntryId:     Number(r.vault_entry_id),
      entitySerial:     r.entity_serial as string | null,
      entityName:       r.entity_name as string | null,
      category:         r.category as string | null,
      totalProjects:    Number(r.total_projects),
      completedProjects: Number(r.completed_projects),
      ongoingProjects:  Number(r.ongoing_projects),
      activeProjects:       Number(r.active_projects),
      disqualifiedProjects: Number(r.disqualified_projects),
      bannedProjects:       Number(r.banned_projects),
      cancelledProjects:    Number(r.cancelled_projects),
      totalCompletions: Number(r.total_completions),
      totalProfit:      Number(r.total_profit),
      totalCost:        Number(r.total_cost),
      totalRoi:         Number(r.total_profit) - Number(r.total_cost),
    }))
    .sort((a, b) => b.totalRoi - a.totalRoi)
    .map((e, i) => ({ ...e, rank: i + 1 }));
}
