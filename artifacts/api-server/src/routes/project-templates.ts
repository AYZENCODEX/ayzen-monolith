/**
 * routes/project-templates.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Thin adapter (PRJ-03). Template logic lives in projects/application/templates.ts, rules in
 * projects/domain/template.ts, queries in projects/infrastructure/repositories/templates-repo.ts.
 * This file only parses HTTP input and maps use-case results to responses. Paths, middleware, status
 * codes, error bodies and the 409 name-clash mapping are unchanged.
 *
 * requireRoles("admin", "moderator") throughout (reads also allow "dev"), same as POST /projects itself.
 * Templates are a shared team resource, not scoped per-admin: there is no per-user ownership check on
 * purpose. See migrations/070_ayzen_project_templates.sql, 071_ayzen_project_templates_extend.sql and
 * lib/db/src/schema/project-templates.ts for the rationale (folder, usageCount, defaultForProjectType).
 */
import { Router } from "express";
import { requireRoles, getRequestUserId } from "../middlewares/auth";
import { isTemplateNameClash } from "../projects/domain/template";
import {
  applyTemplate,
  createTemplate,
  createTemplateFromProject,
  duplicateTemplate,
  getTemplate,
  listAllTemplates,
  removeTemplate,
  updateTemplate,
} from "../projects/application/templates";

const router = Router();

// GET /project-templates — list all, most-recently-updated first. Powers both the manager page and the
// "Load from Template" dropdown in the create dialog.
router.get("/project-templates", requireRoles("admin", "moderator", "dev"), async (_req, res): Promise<void> => {
  res.json(await listAllTemplates());
});

router.get("/project-templates/:id", requireRoles("admin", "moderator", "dev"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const result = await getTemplate(id);
  if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
  res.json(result.template);
});

router.post("/project-templates", requireRoles("admin", "moderator"), async (req, res): Promise<void> => {
  const { name } = req.body;
  const adminUserId = getRequestUserId(req);
  try {
    const result = await createTemplate({ body: req.body, createdBy: adminUserId });
    if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
    res.status(201).json(result.template);
  } catch (err: any) {
    // Unique (lower(name)) violation — same 409-with-clear-message pattern ayzen-mailbox.ts uses.
    if (isTemplateNameClash(err)) {
      res.status(409).json({ error: `A template named "${name.trim()}" already exists` });
      return;
    }
    throw err;
  }
});

router.patch("/project-templates/:id", requireRoles("admin", "moderator"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  try {
    const result = await updateTemplate(id, req.body);
    if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
    res.json(result.template);
  } catch (err: any) {
    if (isTemplateNameClash(err)) {
      res.status(409).json({ error: `A template named "${req.body.name}" already exists` });
      return;
    }
    throw err;
  }
});

router.delete("/project-templates/:id", requireRoles("admin", "moderator"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!(await removeTemplate(id))) { res.status(404).json({ error: "Template not found" }); return; }
  res.json({ ok: true });
});

// POST /project-templates/:id/apply — records that a template was actually used (bumps usage_count).
// Deliberately separate from GET: listing/viewing a template must never count as a "use".
router.post("/project-templates/:id/apply", requireRoles("admin", "moderator"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const result = await applyTemplate(id);
  if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
  res.json(result.template);
});

// POST /project-templates/:id/duplicate — clones data/folder as "Copy of X" (counter-suffixed on a clash).
// Never copies defaultForProjectType: a duplicate must not steal that slot from the original.
router.post("/project-templates/:id/duplicate", requireRoles("admin", "moderator"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const adminUserId = getRequestUserId(req);
  const result = await duplicateTemplate(id, adminUserId);
  if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
  res.status(201).json(result.template);
});

// POST /project-templates/from-project/:projectId — builds a new template from an EXISTING project's
// allow-listed fields (never name/description/media/social/money). Read-only on projects; see
// projects/application/templates.ts for the raw-SELECT rationale.
router.post("/project-templates/from-project/:projectId", requireRoles("admin", "moderator"), async (req, res): Promise<void> => {
  const projectId = parseInt(req.params.projectId, 10);
  const { name } = req.body;
  const adminUserId = getRequestUserId(req);
  try {
    const result = await createTemplateFromProject({ projectId, body: req.body, createdBy: adminUserId });
    if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
    res.status(201).json(result.template);
  } catch (err: any) {
    if (isTemplateNameClash(err)) {
      res.status(409).json({ error: `A template named "${name.trim()}" already exists` });
      return;
    }
    throw err;
  }
});

export default router;
