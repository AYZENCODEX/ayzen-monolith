/**
 * projects/application/templates.ts
 * Template use cases (PRJ-03). Moved unchanged from routes/project-templates.ts. Templates never create or
 * update projects: `from-project` only READS one project (via projects-repo) to build a template from it.
 * Database errors, including the unique-name violation, propagate; the adapter maps the violation to 409.
 */
import { PROJECT_TEMPLATE_DATA_KEYS } from "@workspace/db";
import {
  buildTemplateUpdates,
  duplicateTemplateName,
  formatTemplate,
  isValidTemplateName,
  NAME_REQUIRED_ERROR,
  pickTemplateData,
  TEMPLATE_NOT_FOUND_ERROR,
  templateInputFromProjectRow,
} from "../domain/template";
import { findProjectRowById } from "../infrastructure/repositories/projects-repo";
import {
  bumpTemplateUsage,
  deleteTemplate,
  findTemplate,
  insertTemplate,
  insertTemplateClearingDefault,
  listTemplates,
  templateNameTaken,
  updateTemplateClearingDefault,
} from "../infrastructure/repositories/templates-repo";

type Formatted = ReturnType<typeof formatTemplate>;
type Failure = { ok: false; status: 400 | 404; error: string };

export async function listAllTemplates() {
  return { templates: (await listTemplates()).map(formatTemplate) };
}

export async function getTemplate(id: number): Promise<{ ok: true; template: Formatted } | Failure> {
  const row = await findTemplate(id);
  if (!row) return { ok: false, status: 404, error: TEMPLATE_NOT_FOUND_ERROR };
  return { ok: true, template: formatTemplate(row) };
}

export async function createTemplate(input: {
  body: Record<string, any>; createdBy: number | null | undefined;
}): Promise<{ ok: true; template: Formatted } | Failure> {
  const { name, description, folder } = input.body;
  if (!isValidTemplateName(name)) return { ok: false, status: 400, error: NAME_REQUIRED_ERROR };
  const data = pickTemplateData(input.body.data, PROJECT_TEMPLATE_DATA_KEYS);
  const defaultForProjectType = input.body.defaultForProjectType || null;
  const row = await insertTemplateClearingDefault({
    name: name.trim(),
    description: description?.trim() || null,
    data: JSON.stringify(data),
    folder: folder?.trim() || null,
    defaultForProjectType,
    createdBy: input.createdBy ?? 0,
  });
  return { ok: true, template: formatTemplate(row) };
}

export async function updateTemplate(id: number, body: Record<string, any>): Promise<{ ok: true; template: Formatted } | Failure> {
  const existing = await findTemplate(id);
  if (!existing) return { ok: false, status: 404, error: TEMPLATE_NOT_FOUND_ERROR };
  const built = buildTemplateUpdates(body, PROJECT_TEMPLATE_DATA_KEYS, new Date());
  if ("error" in built) return { ok: false, status: 400, error: built.error };
  const row = await updateTemplateClearingDefault(id, built.updates, built.nextDefaultType);
  return { ok: true, template: formatTemplate(row) };
}

export async function removeTemplate(id: number): Promise<boolean> {
  return Boolean(await deleteTemplate(id));
}

/** Records that a template was actually used (bumps usage_count). Listing/viewing never counts. */
export async function applyTemplate(id: number): Promise<{ ok: true; template: Formatted } | Failure> {
  const row = await bumpTemplateUsage(id);
  if (!row) return { ok: false, status: 404, error: TEMPLATE_NOT_FOUND_ERROR };
  return { ok: true, template: formatTemplate(row) };
}

/** Clones data/folder as "Copy of X" (counter-suffixed on a clash). Never copies defaultForProjectType. */
export async function duplicateTemplate(id: number, createdBy: number | null | undefined): Promise<{ ok: true; template: Formatted } | Failure> {
  const source = await findTemplate(id);
  if (!source) return { ok: false, status: 404, error: TEMPLATE_NOT_FOUND_ERROR };

  let candidateName = duplicateTemplateName(source.name, null);
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!(await templateNameTaken(candidateName))) break;
    candidateName = duplicateTemplateName(source.name, attempt);
  }

  const row = await insertTemplate({
    name: candidateName,
    description: source.description,
    data: source.data,
    folder: source.folder,
    createdBy: createdBy ?? 0,
  });
  return { ok: true, template: formatTemplate(row) };
}

/** Builds a template from an existing project's allow-listed fields (read-only on projects). */
export async function createTemplateFromProject(input: {
  projectId: number; body: Record<string, any>; createdBy: number | null | undefined;
}): Promise<{ ok: true; template: Formatted } | Failure> {
  const { name, description, folder } = input.body;
  if (!isValidTemplateName(name)) return { ok: false, status: 400, error: NAME_REQUIRED_ERROR };

  const p = await findProjectRowById(input.projectId);
  if (!p) return { ok: false, status: 404, error: "Project not found" };

  const data = pickTemplateData(templateInputFromProjectRow(p), PROJECT_TEMPLATE_DATA_KEYS);
  const row = await insertTemplate({
    name: name.trim(),
    description: description?.trim() || `Saved from ${p.name}`,
    data: JSON.stringify(data),
    folder: folder?.trim() || null,
    createdBy: input.createdBy ?? 0,
  });
  return { ok: true, template: formatTemplate(row) };
}
