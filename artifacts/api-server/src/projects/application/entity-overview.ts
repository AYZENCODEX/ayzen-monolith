/**
 * projects/application/entity-overview.ts
 * Per-entity overview and entity leaderboard (PRJ-05). Moved unchanged from routes/projects.ts. The three
 * overview queries run in the same order as before (projects, entity, activity).
 */
import { buildEntityLeaderboard, buildEntityOverview } from "../domain/entity-overview";
import {
  queryEntityActivityRows,
  queryEntityLeaderboardRows,
  queryEntityProjectRows,
  queryEntityRow,
} from "../infrastructure/repositories/entity-overview-repo";

export async function getEntityOverview(userId: number, vaultEntryId: number) {
  const rows = await queryEntityProjectRows(userId, vaultEntryId);
  const entityRows = await queryEntityRow(userId, vaultEntryId);
  const activityRows = await queryEntityActivityRows(userId, vaultEntryId);
  return buildEntityOverview(vaultEntryId, rows, entityRows, activityRows);
}

export async function getEntityLeaderboard(userId: number) {
  return buildEntityLeaderboard(await queryEntityLeaderboardRows(userId));
}
