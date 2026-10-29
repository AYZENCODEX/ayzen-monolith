/**
 * projects/application/ratings.ts
 * Rating use cases (PRJ-03). Moved unchanged from routes/projects.ts. The realtime
 * `projects_updated` broadcast is emitted here, after the write and before the adapter responds,
 * exactly where the route emitted it. Database errors propagate to the adapter.
 */
import { broadcastEvent } from "../../lib/event-hub";
import { formatOwnRating, parseRatingValue, RATING_ERROR, summarizeRatings } from "../domain/rating";
import { findProjectById } from "../infrastructure/repositories/projects-repo";
import {
  deleteRatingById,
  deleteUserRating,
  findUserRatings,
  insertRating,
  listRatingsWithUsernames,
  updateUserRating,
} from "../infrastructure/repositories/ratings-repo";

export async function getProjectRatings(projectId: number) {
  return summarizeRatings(await listRatingsWithUsernames(projectId));
}

export async function getMyRating(projectId: number, userId: number) {
  const [rating] = await findUserRatings(projectId, userId);
  return rating ? formatOwnRating(rating) : null;
}

export type SubmitRatingResult =
  | { ok: true; created: boolean; rating: ReturnType<typeof formatOwnRating> }
  | { ok: false; status: 400 | 404; error: string };

/** Create or update (upsert) the caller's rating. */
export async function submitRating(
  projectId: number,
  userId: number,
  input: { rating: unknown; comment?: string | null },
): Promise<SubmitRatingResult> {
  const ratingNum = parseRatingValue(input.rating);
  if (ratingNum === null) return { ok: false, status: 400, error: RATING_ERROR };

  const project = await findProjectById(projectId);
  if (!project) return { ok: false, status: 404, error: "Project not found" };

  const existing = await findUserRatings(projectId, userId);
  const comment = input.comment ?? null;
  const updating = existing.length > 0;
  const row = updating
    ? await updateUserRating(projectId, userId, { rating: ratingNum, comment })
    : await insertRating({ userId, projectId, rating: ratingNum, comment });
  broadcastEvent("projects_updated", { action: "rated", projectId });
  return { ok: true, created: !updating, rating: formatOwnRating(row) };
}

export async function removeMyRating(projectId: number, userId: number): Promise<void> {
  await deleteUserRating(projectId, userId);
}

/** Admin moderation: remove any rating by id. */
export async function removeRatingById(ratingId: number): Promise<void> {
  await deleteRatingById(ratingId);
}
