// projects/infrastructure/repositories/ratings-repo.ts
// The single repository over the `project_ratings` table (PRJ-03). Repositories only run queries.
import { db, projectRatingsTable, usersTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";

export function listRatingsWithUsernames(projectId: number) {
  return db
    .select({ r: projectRatingsTable, username: usersTable.username })
    .from(projectRatingsTable)
    .leftJoin(usersTable, eq(projectRatingsTable.userId, usersTable.id))
    .where(eq(projectRatingsTable.projectId, projectId))
    .orderBy(sql`${projectRatingsTable.updatedAt} DESC`);
}

export function findUserRatings(projectId: number, userId: number) {
  return db.select().from(projectRatingsTable)
    .where(and(eq(projectRatingsTable.projectId, projectId), eq(projectRatingsTable.userId, userId)));
}

export async function updateUserRating(projectId: number, userId: number, values: { rating: number; comment: string | null }) {
  const [row] = await db.update(projectRatingsTable)
    .set({ rating: values.rating, comment: values.comment, updatedAt: new Date() })
    .where(and(eq(projectRatingsTable.projectId, projectId), eq(projectRatingsTable.userId, userId)))
    .returning();
  return row;
}

export async function insertRating(values: { userId: number; projectId: number; rating: number; comment: string | null }) {
  const [row] = await db.insert(projectRatingsTable).values(values).returning();
  return row;
}

export async function deleteUserRating(projectId: number, userId: number): Promise<void> {
  await db.delete(projectRatingsTable)
    .where(and(eq(projectRatingsTable.projectId, projectId), eq(projectRatingsTable.userId, userId)));
}

export async function deleteRatingById(ratingId: number): Promise<void> {
  await db.delete(projectRatingsTable).where(eq(projectRatingsTable.id, ratingId));
}
