// projects/infrastructure/sql/project-raw-sets.ts
// SQL assignment fragments for `projects` columns that are not in the Drizzle definition. Pure string
// building, moved from routes/projects.ts in PRJ-03. Every request-supplied value goes through `esc` (single
// quotes doubled). Before PRJ-06, `deadline` (POST, PATCH) and `startedAt` (PATCH) were interpolated WITHOUT
// escaping (PRJ-ISSUE-1, SQL injection for admin/moderator callers); they now use `esc` like the other fields.
// Valid date strings produce identical SQL, so only malicious or malformed input behaves differently.
const esc = (v: unknown) => String(v).replace(/'/g, "''");

export function buildRawCreateSets(body: any): string[] {
  const sets: string[] = [];
  if (body.category !== undefined) sets.push(`category = '${esc(body.category)}'`);
  if (body.projectType !== undefined) sets.push(`project_type = '${esc(body.projectType)}'`);
  if (body.exchangeSubType !== undefined) sets.push(`exchange_sub_type = '${esc(body.exchangeSubType)}'`);
  if (body.accountCategory !== undefined) sets.push(`account_category = '${esc(body.accountCategory)}'`);
  if (body.deadline) sets.push(`deadline = '${esc(body.deadline)}'`);
  if (body.durationType !== undefined) sets.push(`duration_type = '${esc(body.durationType)}'`);
  if (body.difficulty !== undefined) sets.push(`difficulty = '${esc(body.difficulty)}'`);
  if (body.costType !== undefined) sets.push(`cost_type = '${esc(body.costType)}'`);
  return sets;
}

export function buildRawUpdateSets(body: any): string[] {
  const sets: string[] = [];
  if (body.deadline !== undefined) sets.push(`deadline = ${body.deadline ? `'${esc(body.deadline)}'` : "NULL"}`);
  if (body.startedAt !== undefined) sets.push(`started_at = ${body.startedAt ? `'${esc(body.startedAt)}'` : "NULL"}`);
  if (body.status !== undefined) sets.push(`status = '${esc(body.status)}'`);
  if (body.projectType !== undefined) sets.push(`project_type = '${esc(body.projectType)}'`);
  if (body.exchangeSubType !== undefined) sets.push(`exchange_sub_type = '${esc(body.exchangeSubType)}'`);
  if (body.accountCategory !== undefined) sets.push(`account_category = '${esc(body.accountCategory)}'`);
  if (body.exchangeCustomCategories !== undefined) sets.push(`exchange_custom_categories = ${body.exchangeCustomCategories ? `'${JSON.stringify(body.exchangeCustomCategories).replace(/'/g, "''")}'` : "NULL"}`);
  if (body.durationType !== undefined) sets.push(`duration_type = '${esc(body.durationType)}'`);
  if (body.difficulty !== undefined) sets.push(`difficulty = '${esc(body.difficulty)}'`);
  if (body.costType !== undefined) sets.push(`cost_type = '${esc(body.costType)}'`);
  if (body.category !== undefined) sets.push(`category = '${esc(body.category)}'`);
  return sets;
}
