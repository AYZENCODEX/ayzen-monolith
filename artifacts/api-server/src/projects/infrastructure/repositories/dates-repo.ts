// projects/infrastructure/repositories/dates-repo.ts
// The single repository over the `project_dates` table (PRJ-02). It serves routes/project-dates.ts
// (via application/dates.ts) and lib/airdrop-reminder-cron.ts. Repositories only run queries.
import { db, projectDatesTable, projectsTable, projectEnrollmentsTable } from "@workspace/db";
import { eq, and, gte, lte, isNull, inArray } from "drizzle-orm";
import type { ProjectDateUpdates } from "../../domain/project-date";

export async function listEnrolledProjectIds(userId: number): Promise<number[]> {
  const enrollments = await db.select({ projectId: projectEnrollmentsTable.projectId })
    .from(projectEnrollmentsTable)
    .where(eq(projectEnrollmentsTable.userId, userId));
  return [...new Set(enrollments.map((e) => e.projectId))];
}

export function listCalendarRows(opts: { projectIdFilter: number[] | null; upcomingOnly: boolean }) {
  return db.select({
    id: projectDatesTable.id,
    projectId: projectDatesTable.projectId,
    label: projectDatesTable.label,
    eventType: projectDatesTable.eventType,
    eventDate: projectDatesTable.eventDate,
    notes: projectDatesTable.notes,
    remindedAt: projectDatesTable.remindedAt,
    createdAt: projectDatesTable.createdAt,
    projectName: projectsTable.name,
    thumbnailUrl: projectsTable.thumbnailUrl,
  })
    .from(projectDatesTable)
    .leftJoin(projectsTable, eq(projectDatesTable.projectId, projectsTable.id))
    .where(and(
      opts.upcomingOnly ? gte(projectDatesTable.eventDate, new Date(Date.now() - 24 * 60 * 60 * 1000)) : undefined,
      opts.projectIdFilter ? inArray(projectDatesTable.projectId, opts.projectIdFilter) : undefined,
    ));
}

export function listDatesForProject(projectId: number) {
  return db.select().from(projectDatesTable).where(eq(projectDatesTable.projectId, projectId));
}

export async function insertDate(values: { projectId: number; label: string; eventType: string; eventDate: Date; notes: string | null }) {
  const [row] = await db.insert(projectDatesTable).values(values).returning();
  return row;
}

export async function updateDate(id: number, updates: ProjectDateUpdates) {
  const [row] = await db.update(projectDatesTable).set(updates).where(eq(projectDatesTable.id, id)).returning();
  return row;
}

export async function deleteDate(id: number) {
  const [row] = await db.delete(projectDatesTable).where(eq(projectDatesTable.id, id)).returning();
  return row;
}

/** Cron read: dates inside the window that have not been reminded about yet. */
export function findDueReminderDates(windowStart: Date, windowEnd: Date) {
  return db.select({
    id: projectDatesTable.id,
    projectId: projectDatesTable.projectId,
    label: projectDatesTable.label,
    eventType: projectDatesTable.eventType,
    eventDate: projectDatesTable.eventDate,
    projectName: projectsTable.name,
  })
    .from(projectDatesTable)
    .leftJoin(projectsTable, eq(projectDatesTable.projectId, projectsTable.id))
    .where(and(
      isNull(projectDatesTable.remindedAt),
      gte(projectDatesTable.eventDate, windowStart),
      lte(projectDatesTable.eventDate, windowEnd),
    ));
}

export async function markDateReminded(id: number): Promise<void> {
  await db.update(projectDatesTable).set({ remindedAt: new Date() }).where(eq(projectDatesTable.id, id));
}
