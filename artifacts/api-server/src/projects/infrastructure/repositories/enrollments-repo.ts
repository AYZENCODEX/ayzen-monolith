// projects/infrastructure/repositories/enrollments-repo.ts
// Queries over `project_enrollments` and `user_projects` (PRJ-05). Repositories only run queries; the
// enroll/moderate/leave rules live in application/enrollment.ts and domain/enrollment-status.ts.
import { db, projectEnrollmentsTable, userProjectsTable, vaultEntriesTable, usersTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";

type EnrollmentInsert = typeof projectEnrollmentsTable.$inferInsert;

export function listUserEnrollmentsForProject(projectId: number, userId: number) {
  return db.select().from(projectEnrollmentsTable)
    .where(and(eq(projectEnrollmentsTable.projectId, projectId), eq(projectEnrollmentsTable.userId, userId)));
}

/** Owner of an enrollment, for the PEP gate. Undefined when the enrollment does not exist. */
export async function findEnrollmentOwnerId(enrollmentId: number): Promise<number | undefined> {
  const [row] = await db.select({ userId: projectEnrollmentsTable.userId }).from(projectEnrollmentsTable)
    .where(eq(projectEnrollmentsTable.id, enrollmentId)).limit(1);
  return row?.userId;
}

export function findUserProjectLinks(userId: number, projectId: number) {
  return db.select().from(userProjectsTable).where(and(eq(userProjectsTable.userId, userId), eq(userProjectsTable.projectId, projectId)));
}

export async function insertUserProject(userId: number, projectId: number): Promise<void> {
  await db.insert(userProjectsTable).values({ userId, projectId });
}

export async function findEnrollmentById(enrollmentId: number) {
  const [existing] = await db.select().from(projectEnrollmentsTable).where(eq(projectEnrollmentsTable.id, enrollmentId));
  return existing;
}

export async function findActiveEnrollmentByKyc(kycEntryId: number) {
  const [inUse] = await db.select().from(projectEnrollmentsTable)
    .where(and(eq(projectEnrollmentsTable.kycEntryId, kycEntryId), eq(projectEnrollmentsTable.status, "active")));
  return inUse;
}

export async function findEnrollmentForEntity(projectId: number, userId: number, vaultEntryId: number) {
  const [existing] = await db.select().from(projectEnrollmentsTable)
    .where(and(eq(projectEnrollmentsTable.projectId, projectId), eq(projectEnrollmentsTable.userId, userId), eq(projectEnrollmentsTable.vaultEntryId, vaultEntryId)));
  return existing;
}

export async function updateEnrollment(enrollmentId: number, set: Partial<EnrollmentInsert>) {
  const [row] = await db.update(projectEnrollmentsTable).set(set).where(eq(projectEnrollmentsTable.id, enrollmentId)).returning();
  return row;
}

export async function insertEnrollment(values: EnrollmentInsert) {
  const [row] = await db.insert(projectEnrollmentsTable).values(values).returning();
  return row;
}

export function listAdminEntityEnrollments(projectId: number) {
  return db
    .select({ enrollment: projectEnrollmentsTable, vault: vaultEntriesTable, ownerUsername: usersTable.username })
    .from(projectEnrollmentsTable)
    .leftJoin(vaultEntriesTable, eq(projectEnrollmentsTable.vaultEntryId, vaultEntriesTable.id))
    .leftJoin(usersTable, eq(projectEnrollmentsTable.userId, usersTable.id))
    .where(eq(projectEnrollmentsTable.projectId, projectId));
}

export function listUserEnrollmentsWithVault(projectId: number, userId: number) {
  return db
    .select({ enrollment: projectEnrollmentsTable, vault: vaultEntriesTable })
    .from(projectEnrollmentsTable)
    .leftJoin(vaultEntriesTable, eq(projectEnrollmentsTable.vaultEntryId, vaultEntriesTable.id))
    .where(and(eq(projectEnrollmentsTable.projectId, projectId), eq(projectEnrollmentsTable.userId, userId)));
}

/** The caller's own enrollment row (id AND user), used by leave and activity. */
export async function findOwnEnrollment(enrollmentId: number, userId: number) {
  const [row] = await db.select().from(projectEnrollmentsTable)
    .where(and(eq(projectEnrollmentsTable.id, enrollmentId), eq(projectEnrollmentsTable.userId, userId)));
  return row;
}

export async function deleteOwnEnrollment(enrollmentId: number, userId: number): Promise<void> {
  await db.delete(projectEnrollmentsTable)
    .where(and(eq(projectEnrollmentsTable.id, enrollmentId), eq(projectEnrollmentsTable.userId, userId)));
}

/** Existing enrollment rows (any status) for a caller's entities in one project, for the bulk-enroll plan (PRJ-ISSUE-4). */
export async function listEnrollmentsForEntities(projectId: number, userId: number, vaultEntryIds: number[]) {
  if (!vaultEntryIds.length) return [];
  return db.select({ id: projectEnrollmentsTable.id, vaultEntryId: projectEnrollmentsTable.vaultEntryId, status: projectEnrollmentsTable.status })
    .from(projectEnrollmentsTable)
    .where(and(eq(projectEnrollmentsTable.projectId, projectId), eq(projectEnrollmentsTable.userId, userId), inArray(projectEnrollmentsTable.vaultEntryId, vaultEntryIds)));
}
