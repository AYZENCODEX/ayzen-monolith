import { Router } from "express";
import { requireAuth } from "../middlewares/auth";
import { acieEngine, type AcieContext, type AnalysisInput, type Json } from "../lib/acie";
import { getCurrentTraceContext } from "../lib/trace-context";

const router = Router();
router.use(requireAuth);

function objectBody(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Request body must be an object");
  return value as Json;
}

function context(req: { user?: { userId?: number; organizationId?: number } }): AcieContext {
  const trace = getCurrentTraceContext();
  return {
    tenantId: `user:${req.user?.userId ?? "unknown"}`,
    actorId: req.user?.userId,
    traceId: trace?.traceId ?? `request:${Date.now()}`,
    correlationId: trace?.correlationId,
    source: "api",
  };
}

function handle(error: unknown, res: { status: (code: number) => { json: (value: unknown) => void } }): void {
  const message = error instanceof Error ? error.message : String(error);
  res.status(/not found/i.test(message) ? 404 : 400).json({ error: message, code: "ACIE_REQUEST_INVALID" });
}

router.get("/acie/health", (_req, res) => res.json(acieEngine.health()));
router.post("/acie/analyze", (req, res) => {
  try {
    const input = objectBody(req.body) as unknown as Partial<AnalysisInput>;
    res.status(201).json({ results: acieEngine.analyze({ ...input, context: context(req) } as AnalysisInput) });
  } catch (error) { handle(error, res); }
});
router.post("/acie/closed-loop", (req, res) => {
  try {
    const input = objectBody(req.body) as unknown as Partial<AnalysisInput> & { decision?: { decision: string; action?: string; expectedOutcome?: string } };
    res.status(201).json(acieEngine.closeLoop({ ...input, context: context(req) } as AnalysisInput & { decision?: { decision: string; action?: string; expectedOutcome?: string } }));
  } catch (error) { handle(error, res); }
});
router.post("/acie/decisions", (req, res) => {
  try {
    const input = objectBody(req.body);
    res.status(201).json(acieEngine.recordDecision(context(req), { subjectId: String(input.subjectId), decision: String(input.decision), evidenceIds: Array.isArray(input.evidenceIds) ? input.evidenceIds.map(String) : [], action: typeof input.action === "string" ? input.action : undefined, expectedOutcome: typeof input.expectedOutcome === "string" ? input.expectedOutcome : undefined }));
  } catch (error) { handle(error, res); }
});
router.post("/acie/decisions/:id/outcome", (req, res) => {
  try {
    const input = objectBody(req.body);
    res.json(acieEngine.recordOutcome(context(req), { decisionId: req.params.id, actualOutcome: typeof input.actualOutcome === "string" ? input.actualOutcome : undefined, status: input.status as never }));
  } catch (error) { handle(error, res); }
});
router.get("/acie/results", (req, res) => res.json({ results: acieEngine.listResults(context(req).tenantId, typeof req.query.subjectId === "string" ? req.query.subjectId : undefined) }));
router.post("/acie/strategic", (req, res) => {
  try { res.status(201).json(acieEngine.strategic(context(req))); } catch (error) { handle(error, res); }
});

export default router;