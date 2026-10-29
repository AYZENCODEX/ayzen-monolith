/**
 * projects/domain/rating.ts
 * Pure rating rules: value validation, summary statistics and the public row shape.
 * No database, HTTP, or logging dependencies. Moved unchanged from routes/projects.ts (PRJ-03).
 */

export const RATING_ERROR = "rating must be an integer from 1 to 5";

/** Returns the rating as an integer 1..5, or null when invalid. Uses Number() coercion exactly as before. */
export function parseRatingValue(rating: unknown): number | null {
  const n = Number(rating);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

export interface RatingRecord {
  id: number;
  userId: number;
  rating: number;
  comment: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function summarizeRatings(rows: { r: RatingRecord; username: string | null }[]) {
  const ratings = rows.map(({ r, username }) => ({
    id: r.id, userId: r.userId, username: username ?? "Unknown",
    rating: r.rating, comment: r.comment,
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  }));
  const count = ratings.length;
  const average = count > 0 ? ratings.reduce((s, r) => s + r.rating, 0) / count : 0;
  const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of ratings) if (distribution[r.rating] !== undefined) distribution[r.rating]++;
  return { ratings, count, average: Math.round(average * 100) / 100, distribution };
}

/** Own-rating response shape: every column as stored, with the two timestamps as ISO strings. */
export function formatOwnRating<T extends { createdAt: Date; updatedAt: Date }>(r: T) {
  return { ...r, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() };
}
