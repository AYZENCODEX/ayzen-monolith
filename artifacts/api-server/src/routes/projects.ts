/**
 * routes/projects.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Thin compatibility adapter (PRJ-05). Every route keeps its path, middleware chain, registration order,
 * status codes and error bodies; the logic lives in projects/application/* (rules in projects/domain/*, queries in
 * projects/infrastructure/*, PEP wiring in projects/security/*). This file only parses HTTP input, applies the
 * gates and maps use-case results to responses. It performs no database access.
 *
 * Registration order is part of the public contract and MUST NOT change: Express matches first-registered
 * first. Fixed paths such as /projects/enrolled, /projects/entity-leaderboard and /projects/entity/... come
 * before /projects/:id. Fixed in PRJ-06: GET /projects/mine/enrolled-entities now registers before
 * GET /projects/:id/enrolled-entities (it was unreachable, the frontend page calls it). Reordering is a
 * behavior change and the boundary validator pins the new order.
 *
 * PEP (Route Integration Seasons C9, D7, E3): the ownership gates are unchanged; their code now lives in
 * projects/security/enrollment-ownership.ts and projects/security/entity-ownership.ts. Routes without a gate are,
 * as before, admin/role-gated, self-scoped by construction, or public.
 */
import { Router } from "express";
import { requireAdmin, requireAuth, requireRoles, pepDecisionObserver } from "../middlewares/auth";
import { requireCreditBalance } from "../services/credit-meter";
import { requirePublicAudit } from "../lib/policy/pep/middleware";
import { streamFantasticReceiptPdf } from "../lib/receipt-theme";
import { getMyRating, getProjectRatings, removeMyRating, removeRatingById, submitRating } from "../projects/application/ratings";
import { createProject, deleteProject, getProjectDetail, listProjects, updateProject } from "../projects/application/projects";
import { getPublicReceipt, getPublicReceiptPdfSpec, getRoiSummary, mintPnlReceipt, revokePnlReceipt } from "../projects/application/roi-receipts";
import {
  changeEnrollmentStatus, enrollEntity, getEnrollmentActivitySummary, joinProject, leaveEnrollment,
  listAdminEnrollments, listMyEnrollments, ownEnrollmentExists,
} from "../projects/application/enrollment";
import {
  getEnrolledEntitiesForProject, getEnrolledProjects, getMineEnrolled, getMineEnrolledEntities,
  getMineEntitiesOverview, getMineOverview, getProjectEnrollmentsOverviewFor,
} from "../projects/application/enrollment-overview";
import { getEntityLeaderboard, getEntityOverview } from "../projects/application/entity-overview";
import { getEntityTasks, getProjectStats, listMembers } from "../projects/application/members";
import { requireProjectEnrollmentOwnership } from "../projects/security/enrollment-ownership";
import {
  auditProjectsOwnership, kycEntryAuditEngine, projectEntityOverviewSilentDeny, requireProjectsVaultEntryOwnership,
} from "../projects/security/entity-ownership";

const router = Router();

/** Optional auth for public routes that personalize when a valid token is present. */
async function getOptionalUserId(req: { headers: { authorization?: string } }): Promise<number | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  const { getUserFromToken } = await import("../lib/auth-utils");
  const user = await getUserFromToken(authHeader.replace("Bearer ", "").trim());
  return user ? user.userId : null;
}

const pid = (v: string | string[]) => parseInt(Array.isArray(v) ? v[0] : v, 10);

// GET /projects/entity/:vaultEntryId/overview — cross-project stats for one entity (MUST be before /:id)
router.get("/projects/entity/:vaultEntryId/overview", requireAuth, requireProjectsVaultEntryOwnership("project.entity_overview.read", projectEntityOverviewSilentDeny), async (req, res): Promise<void> => {
  const vaultEntryId = pid(req.params.vaultEntryId);
  const userId = req.user!.userId;
  try {
    res.json(await getEntityOverview(userId, vaultEntryId));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// GET /projects/enrolled — projects the current user has entities enrolled in (active/completed, not cancelled/banned)
router.get("/projects/enrolled", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    res.json(await getEnrolledProjects(userId));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// GET /projects/mine/enrolled-entities — every entity the user has enrolled, with each project's lifecycle status.
// Registered BEFORE GET /projects/:id/enrolled-entities on purpose: Express matches first-registered first, and
// before PRJ-06 this handler sat after the :id route, so ":id" matched "mine" and this handler was unreachable.
router.get("/projects/mine/enrolled-entities", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    res.json(await getMineEnrolledEntities(userId));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// GET /projects/:id/enrolled-entities — vault entities enrolled in a specific project
router.get("/projects/:id/enrolled-entities", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const projectId = pid(req.params.id);
  if (isNaN(projectId)) { res.status(400).json({ error: "Invalid project id" }); return; }
  try {
    res.json(await getEnrolledEntitiesForProject(projectId, userId));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// GET /projects/entity-leaderboard — all entities ranked by ROI (MUST be before /:id)
router.get("/projects/entity-leaderboard", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    res.json(await getEntityLeaderboard(userId));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

router.get("/projects", async (req, res): Promise<void> => {
  res.json(await listProjects(req.query as Record<string, string>));
});

router.post("/projects", requireRoles("admin", "moderator"), async (req, res): Promise<void> => {
  const result = await createProject(req.body);
  if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
  res.status(201).json(result.project);
});

router.get("/projects/:id", async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const userId = await getOptionalUserId(req);
  const detail = await getProjectDetail(id, userId);
  if (!detail) { res.status(404).json({ error: "Project not found" }); return; }
  res.json(detail);
});

router.patch("/projects/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  try {
    const result = await updateProject(id, req.body);
    if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
    res.json(result.project);
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

router.delete("/projects/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  await deleteProject(id);
  res.json({ message: "Project deleted" });
});

router.post("/projects/:id/join", requireAuth, async (req, res): Promise<void> => {
  const projectId = pid(req.params.id);
  const userId = req.user!.userId;
  await joinProject(userId, projectId);
  res.json({ message: "Joined project" });
});

// Enrolling a vault entity into a project is a metered action (workspace.project_use): the credit charge happens
// in the use case after the write commits (reactivation or fresh enrollment); validation failures (404/409/403) never
// touch the ledger.
router.post("/projects/:id/enroll", requireAuth, requireProjectsVaultEntryOwnership("project.enroll", (_req, res) => { res.status(404).json({ error: "Vault entity not found" }); }), requireCreditBalance("workspace.project_use"), async (req, res): Promise<void> => {
  const projectId = pid(req.params.id);
  const userId = req.user!.userId;
  const result = await enrollEntity({
    projectId, userId, body: req.body,
    audit: (action, resource) => auditProjectsOwnership(req, kycEntryAuditEngine, action, resource),
  });
  if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
  res.status(201).json(result.body);
});

// PATCH /projects/:id/enrollments/:enrollmentId/status — Disqualify / Ban / Cancel / restore. Admin/moderator only.
router.patch("/projects/:id/enrollments/:enrollmentId/status", requireRoles("admin", "moderator"), async (req, res): Promise<void> => {
  const enrollmentId = pid(req.params.enrollmentId);
  const { status, reason } = req.body as { status: string; reason?: string };
  const result = await changeEnrollmentStatus({ enrollmentId, status, reason, actorUserId: req.user!.userId });
  if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
  res.json(result.body);
});

// GET /admin/projects/:id/entity-enrollments — every entity enrollment for this project across ALL users
router.get("/admin/projects/:id/entity-enrollments", requireRoles("admin", "moderator"), async (req, res): Promise<void> => {
  const projectId = pid(req.params.id);
  try {
    res.json(await listAdminEnrollments(projectId));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

router.get("/projects/:id/enrollments", requireAuth, async (req, res): Promise<void> => {
  const projectId = pid(req.params.id);
  const userId = req.user!.userId;
  res.json(await listMyEnrollments(projectId, userId));
});

// GET /projects/mine/enrolled — every project the user has an enrollment in, with its enrolled-entity count
router.get("/projects/mine/enrolled", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  res.json(await getMineEnrolled(userId));
});

// GET /projects/mine/overview — aggregate stats across every enrollment, computed from the activity log at read time
router.get("/projects/mine/overview", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    res.json(await getMineOverview(userId));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// GET /projects/mine/entities-overview — same aggregates grouped by entity (vault_entry_id)
router.get("/projects/mine/entities-overview", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    res.json(await getMineEntitiesOverview(userId));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// GET /projects/:id/enrollments/overview — aggregate stats for the user's enrollments within ONE project
router.get("/projects/:id/enrollments/overview", requireAuth, async (req, res): Promise<void> => {
  const projectId = pid(req.params.id);
  const userId = req.user!.userId;
  try {
    res.json(await getProjectEnrollmentsOverviewFor(userId, projectId));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

router.delete("/projects/:id/enrollments/:enrollmentId", requireAuth, requireProjectEnrollmentOwnership("project_enrollment.delete", (_req, res) => {
  res.json({ message: "Enrollment removed" });
}), async (req, res): Promise<void> => {
  const enrollmentId = pid(req.params.enrollmentId);
  const userId = req.user!.userId;
  await leaveEnrollment(enrollmentId, userId);
  res.json({ message: "Enrollment removed" });
});

// GET /projects/enrollments/:enrollmentId/activity — the enrolled/left/reward log plus totals derived at read time
router.get("/projects/enrollments/:enrollmentId/activity", requireAuth, requireProjectEnrollmentOwnership("project_enrollment.activity.read", (_req, res) => {
  res.status(404).json({ error: "Enrollment not found" });
}), async (req, res): Promise<void> => {
  const enrollmentId = pid(req.params.enrollmentId);
  const userId = req.user!.userId;
  if (!(await ownEnrollmentExists(enrollmentId, userId))) { res.status(404).json({ error: "Enrollment not found" }); return; }
  try {
    res.json(await getEnrollmentActivitySummary(enrollmentId));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// GET /projects/:id/members — admin/moderator view of every member (includes email, so it is role-gated)
router.get("/projects/:id/members", requireRoles("admin", "moderator"), async (req, res): Promise<void> => {
  const projectId = pid(req.params.id);
  try {
    res.json(await listMembers(projectId));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

router.get("/projects/:id/stats", async (req, res): Promise<void> => {
  const id = pid(req.params.id);
  res.json(await getProjectStats(id));
});

// ─── GET /api/projects/:id/entity-tasks — per-entity task completion ──────────
router.get("/projects/:id/entity-tasks", requireAuth, async (req, res): Promise<void> => {
  const projectId = pid(req.params.id);
  const userId = req.user!.userId;
  try {
    res.json(await getEntityTasks(projectId, userId));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── GET /projects/:id/ratings — list ratings + average (public) ─────────────
router.get("/projects/:id/ratings", async (req, res): Promise<void> => {
  const projectId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  try {
    res.json(await getProjectRatings(projectId));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── GET /projects/:id/ratings/me — current user's own rating for this project ─
router.get("/projects/:id/ratings/me", requireAuth, async (req, res): Promise<void> => {
  const projectId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const userId = req.user!.userId;
  res.json(await getMyRating(projectId, userId));
});

// ─── POST /projects/:id/ratings — create or update (upsert) own rating ────────
router.post("/projects/:id/ratings", requireAuth, async (req, res): Promise<void> => {
  const projectId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const userId = req.user!.userId;
  const { rating, comment } = req.body;
  const result = await submitRating(projectId, userId, { rating, comment });
  if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
  res.status(result.created ? 201 : 200).json(result.rating);
});

// ─── DELETE /projects/:id/ratings/me — remove own rating ──────────────────────
router.delete("/projects/:id/ratings/me", requireAuth, async (req, res): Promise<void> => {
  const projectId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const userId = req.user!.userId;
  await removeMyRating(projectId, userId);
  res.json({ message: "Rating removed" });
});

// ─── DELETE /admin/projects/:id/ratings/:ratingId — moderate any rating ───────
router.delete("/admin/projects/:id/ratings/:ratingId", requireAdmin, async (req, res): Promise<void> => {
  const ratingId = parseInt(Array.isArray(req.params.ratingId) ? req.params.ratingId[0] : req.params.ratingId, 10);
  await removeRatingById(ratingId);
  res.json({ message: "Rating removed" });
});

// ─── GET /projects/:id/roi-summary — per-entity ROI ledger for this project ───
router.get("/projects/:id/roi-summary", requireAuth, async (req, res): Promise<void> => {
  const projectId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const userId = req.user!.userId;
  try {
    res.json(await getRoiSummary(userId, projectId));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── Public receipt link — Project P&L ────────────────────────────────────────
// One shareable, unauthenticated "P&L card" per (user, project) pair. Same possession-is-auth model as the
// Local Entity / Vault Entity / Finance ledger receipts. Idempotent mint (repeat calls return the same token
// until revoked); revoke deletes the row outright. Logic: projects/application/roi-receipts.ts. The project P&L
// is computed by Projects from raw ledger totals (projects/domain/roi.ts); it is intentionally NOT the converted
// figure that GET /finance/investments shows.

// POST /projects/:id/pnl-receipt — mint (or fetch the existing) public link
router.post("/projects/:id/pnl-receipt", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const projectId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  if (!Number.isFinite(projectId)) { res.status(400).json({ error: "Invalid project id" }); return; }
  try {
    const result = await mintPnlReceipt(userId, projectId);
    if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
    res.json({ token: result.token, url: result.url });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to create receipt link", detail: err?.message });
  }
});

// DELETE /projects/:id/pnl-receipt — revoke the public link
router.delete("/projects/:id/pnl-receipt", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const projectId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  if (!Number.isFinite(projectId)) { res.status(400).json({ error: "Invalid project id" }); return; }
  if (!(await revokePnlReceipt(userId, projectId))) { res.status(404).json({ error: "No active receipt link for this project" }); return; }
  res.json({ success: true });
});

// GET /projects/pnl-receipt/:token — public, no auth
router.get("/projects/pnl-receipt/:token", requirePublicAudit("project_pnl_receipt.view", { onDecision: pepDecisionObserver }), async (req, res): Promise<void> => {
  const token = Array.isArray(req.params.token) ? req.params.token[0] : req.params.token;
  if (!token) { res.status(400).json({ error: "Missing token" }); return; }
  const card = await getPublicReceipt(token);
  if (!card) { res.status(404).json({ error: "This receipt link is invalid or has been revoked." }); return; }
  res.json(card);
});

// GET /projects/pnl-receipt/:token/pdf — public, no auth
router.get("/projects/pnl-receipt/:token/pdf", requirePublicAudit("project_pnl_receipt.pdf", { onDecision: pepDecisionObserver }), async (req, res): Promise<void> => {
  const token = Array.isArray(req.params.token) ? req.params.token[0] : req.params.token;
  if (!token) { res.status(400).json({ error: "Missing token" }); return; }
  const spec = await getPublicReceiptPdfSpec(token);
  if (!spec) { res.status(404).json({ error: "This receipt link is invalid or has been revoked." }); return; }
  streamFantasticReceiptPdf(res, spec);
});

export default router;
