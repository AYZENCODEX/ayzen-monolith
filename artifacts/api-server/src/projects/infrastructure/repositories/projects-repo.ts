// projects/infrastructure/repositories/projects-repo.ts
// Queries over the `projects` table that other Projects use cases need. Grows as core CRUD moves (PRJ-03+).
import { db, projectsTable, tasksTable, userProjectsTable } from "@workspace/db";
import { eq, sql, ilike, and, count } from "drizzle-orm";
import type { ProjectListQuery } from "../../domain/project";

export async function findProjectById(projectId: number) {
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
  return project;
}

/** Raw SELECT on purpose: category/duration_type/difficulty/cost_type are not in projectsTable's Drizzle definition. */
export async function findProjectRowById(projectId: number): Promise<Record<string, unknown> | undefined> {
  const result = await db.execute(sql`SELECT * FROM projects WHERE id = ${projectId}`);
  return result.rows[0] as Record<string, unknown> | undefined;
}

// ── core CRUD (PRJ-03) ───────────────────────────────────────────────────────
export async function listProjectsPage(filters: ProjectListQuery, limitNum: number, offset: number) {
  const { tier, search, type, exchangeSubType, accountCategory } = filters;
  const conditions = [];
  if (tier) conditions.push(eq(projectsTable.tier, tier));
  if (search) conditions.push(ilike(projectsTable.name, `%${search}%`));
  if (type && type !== "all") conditions.push(sql.raw(`project_type = '${type.replace(/'/g,"''")}'`));
  if (exchangeSubType) conditions.push(sql.raw(`exchange_sub_type = '${exchangeSubType.replace(/'/g,"''")}'`));
  if (accountCategory && accountCategory !== "all") conditions.push(sql.raw(`(account_category = '${accountCategory.replace(/'/g,"''")}' OR account_category = 'both')`));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const projects = await db.select().from(projectsTable).where(where).limit(limitNum).offset(offset);
  const [{ total }] = await db.select({ total: count() }).from(projectsTable).where(where);
  return { projects, total: Number(total) };
}

export async function countTasksForProject(projectId: number): Promise<number> {
  const [{ taskCount }] = await db.select({ taskCount: count() }).from(tasksTable).where(eq(tasksTable.projectId, projectId));
  return Number(taskCount);
}

export async function countMembersForProject(projectId: number): Promise<number> {
  const [{ memberCount }] = await db.select({ memberCount: count() }).from(userProjectsTable).where(eq(userProjectsTable.projectId, projectId));
  return Number(memberCount);
}

export function listTasksForProject(projectId: number) {
  return db.select().from(tasksTable).where(eq(tasksTable.projectId, projectId));
}

/** Raw-SQL-only columns that the typed select omits. */
export async function findProjectExtraColumns(projectId: number): Promise<Record<string, unknown> | undefined> {
  const rawExtra = await db.execute(sql`SELECT category, duration_type, difficulty, cost_type FROM projects WHERE id = ${projectId}`);
  return rawExtra.rows[0] as Record<string, unknown> | undefined;
}

export async function insertProject(values: typeof projectsTable.$inferInsert) {
  const [project] = await db.insert(projectsTable).values(values).returning();
  return project;
}

/** Follow-up raw UPDATE ... RETURNING * for columns outside the Drizzle definition. Returns the raw (snake_case) row. */
export async function rawUpdateProjectReturning(projectId: number, sets: string[]) {
  const result = await db.execute(sql.raw(`UPDATE projects SET ${sets.join(", ")} WHERE id = ${projectId} RETURNING *`));
  return result.rows[0];
}

export async function updateProjectFields(projectId: number, updates: Record<string, unknown>) {
  const [p] = await db.update(projectsTable).set(updates).where(eq(projectsTable.id, projectId)).returning();
  return p;
}

export async function deleteProjectById(projectId: number): Promise<void> {
  await db.delete(projectsTable).where(eq(projectsTable.id, projectId));
}

/** Existence check used by receipt minting (selects only the id, as before). */
export async function projectExists(projectId: number): Promise<boolean> {
  const [project] = await db.select({ id: projectsTable.id }).from(projectsTable).where(eq(projectsTable.id, projectId));
  return Boolean(project);
}
