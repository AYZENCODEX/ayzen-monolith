/**
 * projects/domain/project.ts
 * Pure project rules for core CRUD: response shapes, pagination, and the mapping from request bodies to
 * column values. No database, HTTP, or logging dependencies. Moved unchanged from routes/projects.ts (PRJ-03).
 * The raw-SQL column assignments (columns missing from the Drizzle definition) are built in
 * infrastructure/sql/project-raw-sets.ts, because they are SQL text.
 */

export function formatProject<T extends { createdAt: Date }>(p: T, taskCount = 0, completedTaskCount = 0, activeUserCount = 0) {
  return { ...p, createdAt: p.createdAt.toISOString(), taskCount, completedTaskCount, activeUserCount };
}

/**
 * PRJ-ISSUE-2 fix: response for POST /projects. The follow-up raw `UPDATE ... RETURNING *` returns a snake_case
 * row (`created_at`, no `createdAt`), so formatting that row threw after the project was already inserted.
 * The typed insert row (camelCase, `createdAt` a Date) always wins; the raw row only adds the columns outside the
 * Drizzle definition (category, project_type, deadline, ...), as the original response did.
 */
export function formatCreatedProject<T extends { createdAt: Date }>(project: T, raw?: Record<string, unknown> | null) {
  return formatProject({ ...(raw ?? {}), ...project });
}

export interface ProjectListQuery {
  tier?: string; search?: string; page?: string; limit?: string;
  type?: string; exchangeSubType?: string; accountCategory?: string;
}

export function parsePagination(query: Pick<ProjectListQuery, "page" | "limit">) {
  const { page = "1", limit = "20" } = query;
  const pageNum = parseInt(page, 10);
  const limitNum = Math.min(parseInt(limit, 10), 200);
  const offset = (pageNum - 1) * limitNum;
  return { pageNum, limitNum, offset };
}

/** String passes through; anything else (arrays, objects) is stored as JSON text. */
export function toJsonText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Typed insert values for POST /projects. Request bodies are untyped, as before. */
export function buildCreateValues(body: any) {
  const { name, description, xpName, xpPrice, twitterHandle, discordUrl, websiteUrl, tutorialLink, tutorialSteps, badges, experienceLevel, tier, fundingAmount, rewardEstimate, thumbnailUrl, bannerUrl } = body;
  return {
    name, description, xpName: xpName || null, twitterHandle, discordUrl, websiteUrl, tutorialLink,
    // xpPrice has a DB default (0.01); it is only sent when the body actually carries a value.
    xpPrice: xpPrice !== undefined && xpPrice !== null && xpPrice !== "" ? Number(xpPrice) : undefined,
    tutorialSteps: tutorialSteps ? toJsonText(tutorialSteps) : null,
    // Phase 7A — same string-or-array-in, JSON-string-out convention as tutorialSteps.
    badges: badges ? toJsonText(badges) : null,
    experienceLevel: experienceLevel ?? "Beginner",
    tier: tier ?? "1",
    fundingAmount: Number(fundingAmount ?? 0),
    rewardEstimate: Number(rewardEstimate ?? 0),
    thumbnailUrl,
    bannerUrl,
  };
}

export const PATCH_FIELDS = ["name", "description", "xpName", "xpPrice", "twitterHandle", "discordUrl", "websiteUrl", "tutorialLink", "experienceLevel", "tier", "fundingAmount", "rewardEstimate", "thumbnailUrl", "bannerUrl"] as const;

/** Typed column updates for PATCH /projects/:id: only fields present in the body. */
export function buildUpdateFields(body: any): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  for (const f of PATCH_FIELDS) if (body[f] !== undefined) updates[f] = body[f];
  if (body.tutorialSteps !== undefined) updates.tutorialSteps = toJsonText(body.tutorialSteps);
  if (body.badges !== undefined) updates.badges = toJsonText(body.badges);
  return updates;
}

/** PATCH response: the stored row with dates normalized. Accepts both typed (camelCase) and raw (snake_case) rows. */
export function formatUpdatedProject(p: any) {
  return {
    ...p,
    createdAt: p.createdAt instanceof Date ? p.createdAt.toISOString() : p.createdAt,
    deadline: p.deadline instanceof Date ? p.deadline.toISOString() : (p.deadline ?? null),
    startedAt: p.started_at instanceof Date ? p.started_at.toISOString() : (p.started_at ?? null),
    status: p.status ?? "active",
  };
}
