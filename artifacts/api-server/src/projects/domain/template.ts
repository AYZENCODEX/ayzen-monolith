/**
 * projects/domain/template.ts
 * Pure template rules: public shape, allow-listing of template data, update building, name de-duping and the
 * name-clash error test. No database, HTTP, or logging dependencies. Moved unchanged from
 * routes/project-templates.ts (PRJ-03). The allow-list of data keys (PROJECT_TEMPLATE_DATA_KEYS) lives in the
 * DB schema package, so callers pass it in.
 */

export interface TemplateRecord {
  id: number;
  name: string;
  description: string | null;
  data: string;
  folder: string | null;
  usageCount: number;
  defaultForProjectType: string | null;
  createdBy: number;
  createdAt: Date;
  updatedAt: Date;
}

export function formatTemplate(row: TemplateRecord) {
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(row.data); } catch { /* corrupt/legacy row — surface as empty */ }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    data,
    folder: row.folder,
    usageCount: row.usageCount,
    defaultForProjectType: row.defaultForProjectType,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Strips input down to the allow-listed keys only, so a template can never smuggle in identity/media/money
 * fields and a typo'd field on the create form can't silently write garbage into every future template.
 */
export function pickTemplateData(input: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!input || typeof input !== "object") return out;
  for (const key of allowedKeys) {
    const val = (input as Record<string, unknown>)[key];
    if (val !== undefined && val !== null && val !== "") out[key] = val;
  }
  return out;
}

export function isTemplateNameClash(err: unknown): boolean {
  return String((err as { message?: unknown } | null)?.message ?? "").includes("ayzen_project_templates_name_key");
}

export function isValidTemplateName(name: unknown): name is string {
  return Boolean(name) && typeof name === "string" && Boolean(name.trim());
}

export const NAME_REQUIRED_ERROR = "name is required";
export const NAME_EMPTY_ERROR = "name cannot be empty";
export const TEMPLATE_NOT_FOUND_ERROR = "Template not found";

export function duplicateTemplateName(sourceName: string, attempt: number | null): string {
  return attempt === null ? `Copy of ${sourceName}` : `Copy of ${sourceName} (${attempt + 2})`;
}

/** tutorial_steps/badges come back from a raw SELECT as JSON text; templates store real arrays. */
export function parseJsonArray(v: unknown): unknown {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string" || !v) return v;
  try { const parsed = JSON.parse(v); return Array.isArray(parsed) ? parsed : v; } catch { return v; }
}

/** Maps a raw `projects` row (snake_case columns) to template data input. Name/description/media/money never leave. */
export function templateInputFromProjectRow(p: Record<string, unknown>) {
  return {
    category: p.category,
    projectType: p.project_type,
    exchangeSubType: p.exchange_sub_type,
    accountCategory: p.account_category,
    tier: p.tier,
    experienceLevel: p.experience_level,
    durationType: p.duration_type,
    difficulty: p.difficulty,
    costType: p.cost_type,
    xpName: p.xp_name,
    xpPrice: p.xp_price,
    tutorialLink: p.tutorial_link,
    tutorialSteps: parseJsonArray(p.tutorial_steps),
    badges: parseJsonArray(p.badges),
  };
}

export interface TemplateUpdates {
  updatedAt: Date;
  name?: string;
  description?: string | null;
  data?: string;
  folder?: string | null;
  defaultForProjectType?: string | null;
}

/** Builds the PATCH update. `nextDefaultType` is undefined when the field was not sent. */
export function buildTemplateUpdates(
  body: Record<string, any>,
  allowedKeys: readonly string[],
  now: Date,
): { error: string } | { updates: TemplateUpdates; nextDefaultType: string | null | undefined } {
  const updates: TemplateUpdates = { updatedAt: now };
  if (body.name !== undefined) {
    if (!String(body.name).trim()) return { error: NAME_EMPTY_ERROR };
    updates.name = String(body.name).trim();
  }
  if (body.description !== undefined) updates.description = body.description?.trim() || null;
  if (body.data !== undefined) updates.data = JSON.stringify(pickTemplateData(body.data, allowedKeys));
  if (body.folder !== undefined) updates.folder = body.folder?.trim() || null;
  const nextDefaultType = body.defaultForProjectType !== undefined ? (body.defaultForProjectType || null) : undefined;
  if (nextDefaultType !== undefined) updates.defaultForProjectType = nextDefaultType;
  return { updates, nextDefaultType };
}
