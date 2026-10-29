/**
 * projects/application/enrollment-overview.ts
 * Read-only "enrolled" views (PRJ-05). Moved unchanged from routes/projects.ts. The activity-log based
 * aggregates stay in lib/activity-log, which this module calls rather than absorbs.
 */
import { getUserEnrollmentsOverview, getProjectEnrollmentsOverview, getUserEntitiesOverview } from "../../lib/activity-log";
import { groupEnrolledEntities, mapMineEnrolled } from "../domain/enrollment-overview";
import {
  queryEnrolledEntitiesForProject,
  queryEnrolledProjects,
  queryMineEnrolled,
  queryMineEnrolledEntities,
} from "../infrastructure/repositories/enrollment-overview-repo";

export const getEnrolledProjects = (userId: number) => queryEnrolledProjects(userId);
export const getEnrolledEntitiesForProject = (projectId: number, userId: number) => queryEnrolledEntitiesForProject(projectId, userId);
export async function getMineEnrolled(userId: number) { return mapMineEnrolled(await queryMineEnrolled(userId)); }
export async function getMineEnrolledEntities(userId: number) { return groupEnrolledEntities(await queryMineEnrolledEntities(userId)); }
export const getMineOverview = (userId: number) => getUserEnrollmentsOverview(userId);
export const getMineEntitiesOverview = (userId: number) => getUserEntitiesOverview(userId);
export const getProjectEnrollmentsOverviewFor = (userId: number, projectId: number) => getProjectEnrollmentsOverview(userId, projectId);
