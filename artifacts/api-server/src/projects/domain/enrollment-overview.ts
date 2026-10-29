/**
 * projects/domain/enrollment-overview.ts
 * Pure mapping for the "mine" enrollment views. No database, HTTP, or logging dependencies.
 * Moved unchanged from routes/projects.ts (PRJ-05). Row inputs are raw (snake_case) SQL rows.
 */

export function mapMineEnrolled(rows: any[]) {
  return rows.map((r) => ({
    projectId: Number(r.project_id),
    projectName: r.project_name,
    thumbnailUrl: r.thumbnail_url,
    category: r.category,
    enrolledCount: Number(r.enrolled_count),
  }));
}

const ONGOING = new Set(["active", "paused"]);
const PAST = new Set(["completed", "archived"]);

/**
 * One entry per entity with each enrolled project's own lifecycle status attached. "ongoing" = at least one
 * project active/paused, "past" = at least one completed/archived; an entity can be both.
 */
export function groupEnrolledEntities(rows: any[]) {
  const byEntity = new Map<number, any>();
  for (const r of rows) {
    const key = Number(r.vault_entry_id);
    if (!byEntity.has(key)) {
      byEntity.set(key, {
        vaultEntryId: key,
        entityName: r.entity_name as string | null,
        entitySerial: r.entity_serial as string | null,
        category: r.category as string | null,
        projects: [] as any[],
      });
    }
    byEntity.get(key).projects.push({
      projectId: Number(r.project_id),
      projectName: r.project_name as string,
      projectStatus: (r.project_status as string | null) ?? "active",
      thumbnailUrl: r.project_thumbnail_url as string | null,
      enrollmentStatus: r.enrollment_status as string,
      enrolledAt: r.enrolled_at,
    });
  }
  return Array.from(byEntity.values()).map((e) => ({
    ...e,
    hasOngoing: e.projects.some((p: any) => ONGOING.has(p.projectStatus)),
    hasPast: e.projects.some((p: any) => PAST.has(p.projectStatus)),
  }));
}

/** Entity shape on GET /projects/:id/enrollments (vault row may be missing). */
export function formatEnrollmentEntity(vault: any | null | undefined) {
  return vault ? {
    id: vault.id, entitySerial: vault.entitySerial, projectName: vault.projectName,
    category: vault.category, twitterUsername: vault.twitterUsername, discordUsername: vault.discordUsername,
    walletAddresses: vault.walletAddresses ? JSON.parse(vault.walletAddresses) : [], email: vault.email,
  } : null;
}

/** Entity shape on the admin entity-enrollments listing. */
export function formatAdminEnrollmentEntity(vault: any | null | undefined) {
  return vault ? { id: vault.id, entitySerial: vault.entitySerial, projectName: vault.projectName, category: vault.category } : null;
}
