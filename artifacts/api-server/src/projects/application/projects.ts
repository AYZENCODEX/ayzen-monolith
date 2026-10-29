/**
 * projects/application/projects.ts
 * Core project CRUD use cases (PRJ-03). Moved unchanged from routes/projects.ts; the route handlers are thin
 * adapters. Side effects keep their original order: write, realtime broadcast, best-effort Telegram alert
 * (create only), then the adapter responds. `getOptionalUserId` stays in the adapter because it reads the
 * HTTP Authorization header. Database errors propagate; PATCH's adapter keeps its try/catch.
 */
import { broadcastEvent } from "../../lib/event-hub";
import { syncOnProjectDelete } from "../../services/sync";
import {
  buildCreateValues,
  buildUpdateFields,
  formatCreatedProject,
  formatProject,
  formatUpdatedProject,
  parsePagination,
  type ProjectListQuery,
} from "../domain/project";
import { buildRawCreateSets, buildRawUpdateSets } from "../infrastructure/sql/project-raw-sets";
import { listUserEnrollmentsForProject } from "../infrastructure/repositories/enrollments-repo";
import {
  countMembersForProject,
  countTasksForProject,
  deleteProjectById,
  findProjectById,
  findProjectExtraColumns,
  insertProject,
  listProjectsPage,
  listTasksForProject,
  rawUpdateProjectReturning,
  updateProjectFields,
} from "../infrastructure/repositories/projects-repo";

export async function listProjects(query: ProjectListQuery) {
  const { pageNum, limitNum, offset } = parsePagination(query);
  const { projects, total } = await listProjectsPage(query, limitNum, offset);
  const enriched = await Promise.all(projects.map(async (p) => {
    const taskCount = await countTasksForProject(p.id);
    const memberCount = await countMembersForProject(p.id);
    return formatProject(p, taskCount, 0, memberCount);
  }));
  return { projects: enriched, total, page: pageNum, limit: limitNum };
}

/** Project detail with tasks and the caller's enrollment state; null when the project does not exist. */
export async function getProjectDetail(id: number, userId: number | null) {
  const project = await findProjectById(id);
  if (!project) return null;
  const tasks = await listTasksForProject(id);
  const memberCount = await countMembersForProject(id);
  const enrollments = userId ? await listUserEnrollmentsForProject(id, userId) : [];
  const isJoined = enrollments.length > 0;
  // category/duration_type/difficulty/cost_type are raw-SQL-only columns, so the typed select drops them.
  const extra = await findProjectExtraColumns(id);
  return {
    ...formatProject(project, tasks.length, 0, memberCount),
    category: extra?.category ?? null,
    durationType: extra?.duration_type ?? null,
    difficulty: extra?.difficulty ?? null,
    costType: extra?.cost_type ?? null,
    tasks: tasks.map((t) => ({ ...t, createdAt: t.createdAt.toISOString(), projectName: project.name, userStatus: null })),
    isJoined,
    enrollmentCount: enrollments.length,
    userProgress: 0,
  };
}

export type CreateProjectResult = { ok: true; project: ReturnType<typeof formatProject> } | { ok: false; status: 400; error: string };

export async function createProject(body: any): Promise<CreateProjectResult> {
  if (!body.name) return { ok: false, status: 400, error: "name is required" };
  const project = await insertProject(buildCreateValues(body));

  // category/project_type/deadline etc. are not in the typed insert; applied as a follow-up raw UPDATE.
  const createRawSets = buildRawCreateSets(body);
  // PRJ-ISSUE-2: keep the typed row and the raw (snake_case) row apart; the response is built from the typed row.
  let rawRow: Record<string, unknown> | undefined;
  if (createRawSets.length > 0) {
    rawRow = (await rawUpdateProjectReturning(project.id, createRawSets)) as Record<string, unknown> | undefined;
  }

  broadcastEvent("projects_updated", { action: "created", projectId: project.id });

  // Telegram alert: every user with Telegram linked gets pinged. Best-effort, never blocks creation.
  import("../../lib/telegram").then(({ notifyNewProject }) =>
    notifyNewProject({ id: project.id, name: project.name, tier: project.tier })
  ).catch(() => {});

  return { ok: true, project: formatCreatedProject(project, rawRow) };
}

export type UpdateProjectResult = { ok: true; project: ReturnType<typeof formatUpdatedProject> } | { ok: false; status: 404; error: string };

export async function updateProject(id: number, body: any): Promise<UpdateProjectResult> {
  const updates = buildUpdateFields(body);
  const rawSets = buildRawUpdateSets(body);

  let project: any;
  if (Object.keys(updates).length > 0) project = await updateProjectFields(id, updates);
  if (rawSets.length > 0) project = (await rawUpdateProjectReturning(id, rawSets)) ?? project;
  if (!project) project = await findProjectById(id);
  if (!project) return { ok: false, status: 404, error: "Project not found" };
  broadcastEvent("projects_updated", { action: "updated", projectId: id });
  return { ok: true, project: formatUpdatedProject(project) };
}

export async function deleteProject(id: number): Promise<void> {
  await deleteProjectById(id);
  broadcastEvent("projects_updated", { action: "deleted", projectId: id });
  syncOnProjectDelete(id).catch(() => {});
}
