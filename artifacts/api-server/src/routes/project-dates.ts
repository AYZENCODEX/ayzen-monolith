/**
 * routes/project-dates.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Thin adapter (PRJ-02). Airdrop-calendar logic lives in projects/application/dates.ts,
 * rules in projects/domain/project-date.ts, queries in
 * projects/infrastructure/repositories/dates-repo.ts. This file only parses HTTP input
 * and maps use-case results to responses. Paths, middleware, status codes and error
 * bodies are unchanged. The 1-day-ahead Telegram reminder is a separate cron
 * (lib/airdrop-reminder-cron.ts) that now reads the same table through dates-repo.
 */
import { Router } from "express";
import { requireAuth, requireAdmin } from "../middlewares/auth";
import {
  createProjectDate,
  deleteProjectDate,
  listCalendar,
  listProjectDates,
  updateProjectDate,
} from "../projects/application/dates";

const router = Router();

// GET /project-dates — centralized calendar view. ?mine=true → enrolled projects only;
// ?upcomingOnly=true → drop dates more than a day in the past.
router.get("/project-dates", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const mine = req.query.mine === "true";
  const upcomingOnly = req.query.upcomingOnly === "true";

  try {
    res.json(await listCalendar(userId, { mine, upcomingOnly }));
  } catch (err: any) {
    res.status(500).json({ error: "Unable to load calendar", detail: err?.message });
  }
});

// GET /projects/:id/dates — dates for one project. C29: intentionally no enrollment check
// (owner sign-off; the aggregate endpoint already exposes every date to any signed-in user).
// requireAuth is the correct gate. No try/catch here, exactly as before PRJ-02.
router.get("/projects/:id/dates", requireAuth, async (req, res): Promise<void> => {
  const projectId = parseInt(req.params.id as string, 10);
  res.json(await listProjectDates(projectId));
});

// POST /projects/:id/dates — add a date (admin)
router.post("/projects/:id/dates", requireAdmin, async (req, res): Promise<void> => {
  const projectId = parseInt(req.params.id as string, 10);
  const { label, eventType, eventDate, notes } = req.body as {
    label?: string; eventType?: string; eventDate?: string; notes?: string;
  };

  try {
    const result = await createProjectDate(projectId, { label, eventType, eventDate, notes });
    if (!result.ok) { res.status(400).json({ error: result.error }); return; }
    res.status(201).json(result.date);
  } catch (err: any) {
    res.status(500).json({ error: "Unable to add date", detail: err?.message });
  }
});

// PATCH /project-dates/:id — edit a date (admin)
router.patch("/project-dates/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  const { label, eventType, eventDate, notes } = req.body as {
    label?: string; eventType?: string; eventDate?: string; notes?: string;
  };

  try {
    const result = await updateProjectDate(id, { label, eventType, eventDate, notes });
    if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
    res.json(result.date);
  } catch (err: any) {
    res.status(500).json({ error: "Unable to update date", detail: err?.message });
  }
});

// DELETE /project-dates/:id — remove a date (admin). No try/catch, exactly as before PRJ-02.
router.delete("/project-dates/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (!(await deleteProjectDate(id))) { res.status(404).json({ error: "Date not found" }); return; }
  res.json({ success: true });
});

export default router;
