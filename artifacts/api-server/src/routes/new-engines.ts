import { Router } from "express";
import { requireAuth } from "../middlewares/auth";
import {
  consentEngine,
  dataLineageEngine,
  decisionIntelligenceEngine,
  dependencyGraphEngine,
  dependencyResolutionEngine,
  digitalTwinEngine,
  geoIntelligenceEngine,
  impactAnalysisEngine,
  knowledgeGraphEngine,
  newEngineStore,
  optimizationEngine,
  provenanceEngine,
  remediationEngine,
  schemaRegistryEngine,
  searchIndexEngine,
  timeSeriesEngine,
  type JsonObject,
} from "../lib/new-engines";

const router = Router();
router.use(requireAuth);

function body(req: { body?: unknown }): JsonObject {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) throw new Error("Request body must be an object");
  return req.body as JsonObject;
}

function handle(error: unknown, res: { status: (code: number) => { json: (value: unknown) => void } }): void {
  const message = error instanceof Error ? error.message : String(error);
  const notFound = /not found/i.test(message);
  res.status(notFound ? 404 : 400).json({ error: message, code: notFound ? "NOT_FOUND" : "ENGINE_REQUEST_INVALID" });
}

// N1 — Search & Index
router.post("/new-engines/search/index", (req, res) => {
  try { res.status(201).json(searchIndexEngine.index(body(req) as never)); } catch (error) { handle(error, res); }
});
router.post("/new-engines/search/rebuild", (req, res) => {
  try { res.status(201).json(searchIndexEngine.startRebuild(String(body(req).indexName), (body(req).documents ?? []) as never[], Number(body(req).indexVersion ?? 1))); } catch (error) { handle(error, res); }
});
router.post("/new-engines/search/rebuild/:id/resume", (req, res) => {
  try { res.json(searchIndexEngine.resumeRebuild(req.params.id, Number(body(req).batchSize ?? 100))); } catch (error) { handle(error, res); }
});
router.get("/new-engines/search", (req, res) => {
  try {
    res.json(searchIndexEngine.search({
      indexName: String(req.query.indexName),
      query: typeof req.query.query === "string" ? req.query.query : undefined,
      entityType: typeof req.query.entityType === "string" ? req.query.entityType : undefined,
      offset: Number(req.query.offset ?? 0),
      limit: Number(req.query.limit ?? 20),
      canRead: (document) => !document.permissions?.length || document.permissions.includes(`user:${req.user?.userId}`),
    }));
  } catch (error) { handle(error, res); }
});

// N2 — Knowledge Graph
router.put("/new-engines/graph/nodes/:id", (req, res) => {
  try { res.json(knowledgeGraphEngine.upsertNode({ ...body(req), id: req.params.id } as never)); } catch (error) { handle(error, res); }
});
router.put("/new-engines/graph/edges/:id", (req, res) => {
  try { res.json(knowledgeGraphEngine.upsertEdge({ ...body(req), id: req.params.id } as never)); } catch (error) { handle(error, res); }
});
router.get("/new-engines/graph/traverse/:id", (req, res) => {
  try { res.json(knowledgeGraphEngine.traverse(req.params.id, { direction: req.query.direction as "outgoing" | "incoming" | "both" | undefined, maxDepth: Number(req.query.maxDepth ?? 3), maxNodes: Number(req.query.maxNodes ?? 100), canRead: (node) => !node.properties?.private || node.properties.ownerId === req.user?.userId })); } catch (error) { handle(error, res); }
});

// N3 — Schema Registry
router.post("/new-engines/schemas", (req, res) => {
  try { res.status(201).json(schemaRegistryEngine.register(body(req) as never)); } catch (error) { handle(error, res); }
});
router.get("/new-engines/schemas", (req, res) => res.json(schemaRegistryEngine.list(typeof req.query.name === "string" ? req.query.name : undefined)));
router.post("/new-engines/schemas/:name/validate", (req, res) => {
  try { res.json(schemaRegistryEngine.validate(req.params.name, body(req).value as JsonObject, body(req).version === undefined ? undefined : Number(body(req).version))); } catch (error) { handle(error, res); }
});
router.post("/new-engines/schemas/:name/:version/deprecate", (req, res) => {
  try { res.json(schemaRegistryEngine.deprecate(req.params.name, Number(req.params.version))); } catch (error) { handle(error, res); }
});

// N4 — Data Lineage
router.post("/new-engines/lineage", (req, res) => {
  try { res.status(201).json(dataLineageEngine.record(body(req) as never)); } catch (error) { handle(error, res); }
});
router.get("/new-engines/lineage", (req, res) => res.json(dataLineageEngine.list({ sourceId: typeof req.query.sourceId === "string" ? req.query.sourceId : undefined, destinationId: typeof req.query.destinationId === "string" ? req.query.destinationId : undefined, runId: typeof req.query.runId === "string" ? req.query.runId : undefined })));
router.get("/new-engines/lineage/:direction/:id", (req, res) => {
  try { res.json(req.params.direction === "upstream" ? dataLineageEngine.upstream(req.params.id) : dataLineageEngine.downstream(req.params.id)); } catch (error) { handle(error, res); }
});

// N5 — Provenance
router.post("/new-engines/provenance", (req, res) => {
  try { res.status(201).json(provenanceEngine.append({ ...body(req), actor: { ...(body(req).actor as object ?? {}), userId: req.user?.userId } } as never)); } catch (error) { handle(error, res); }
});
router.get("/new-engines/provenance/verify", (req, res) => res.json(provenanceEngine.verify(typeof req.query.type === "string" && typeof req.query.id === "string" ? { type: req.query.type, id: req.query.id } : undefined)));
router.get("/new-engines/provenance", (req, res) => res.json(provenanceEngine.list(typeof req.query.type === "string" && typeof req.query.id === "string" ? { type: req.query.type, id: req.query.id } : undefined)));

// N6 — Time Series
router.post("/new-engines/time-series/points", (req, res) => {
  try { res.status(201).json(timeSeriesEngine.append(body(req) as never)); } catch (error) { handle(error, res); }
});
router.get("/new-engines/time-series/points", (req, res) => res.json(timeSeriesEngine.query({ series: String(req.query.series), from: typeof req.query.from === "string" ? req.query.from : undefined, to: typeof req.query.to === "string" ? req.query.to : undefined, limit: Number(req.query.limit ?? 10000) })));
router.post("/new-engines/time-series/aggregate", (req, res) => {
  try { res.json(timeSeriesEngine.aggregate(body(req) as never)); } catch (error) { handle(error, res); }
});
router.post("/new-engines/time-series/:series/retention", (req, res) => {
  try { res.json({ removed: timeSeriesEngine.applyRetention(req.params.series, Number(body(req).retentionMs)) }); } catch (error) { handle(error, res); }
});

// N7 — Consent (consent is a separate signal; it does not authorize actions).
router.post("/new-engines/consent/versions", (req, res) => {
  try { res.status(201).json(consentEngine.registerVersion(body(req) as never)); } catch (error) { handle(error, res); }
});
router.post("/new-engines/consent/grants", (req, res) => {
  try { res.status(201).json(consentEngine.grant(body(req) as never)); } catch (error) { handle(error, res); }
});
router.post("/new-engines/consent/grants/:id/withdraw", (req, res) => {
  try { res.json(consentEngine.withdraw(req.params.id)); } catch (error) { handle(error, res); }
});
router.get("/new-engines/consent/check", (req, res) => res.json(consentEngine.check(String(req.query.subjectId), String(req.query.consentType), typeof req.query.scopes === "string" ? req.query.scopes.split(",").filter(Boolean) : [], req.query.organizationId ? Number(req.query.organizationId) : undefined)));
router.get("/new-engines/consent/history/:subjectId", (req, res) => res.json(consentEngine.history(req.params.subjectId, typeof req.query.consentType === "string" ? req.query.consentType : undefined)));

// N8 — Geo Intelligence
router.post("/new-engines/geo/regions", (req, res) => {
  try { res.status(201).json(geoIntelligenceEngine.registerRegion(body(req) as never)); } catch (error) { handle(error, res); }
});
router.post("/new-engines/geo/geofences", (req, res) => {
  try { res.status(201).json(geoIntelligenceEngine.registerGeofence(body(req) as never)); } catch (error) { handle(error, res); }
});
router.post("/new-engines/geo/evaluate", (req, res) => {
  try { res.json(geoIntelligenceEngine.evaluate(String(body(req).subjectId), body(req).point as never, body(req).previousPoint as never)); } catch (error) { handle(error, res); }
});
router.get("/new-engines/geo/events", (req, res) => res.json(geoIntelligenceEngine.events(typeof req.query.subjectId === "string" ? req.query.subjectId : undefined)));

// N9/N10 — Dependency Graph and deterministic resolution.
router.put("/new-engines/dependencies/nodes/:id", (req, res) => {
  try { res.json(dependencyGraphEngine.upsertNode({ ...body(req), id: req.params.id } as never)); } catch (error) { handle(error, res); }
});
router.put("/new-engines/dependencies/edges/:id", (req, res) => {
  try { res.json(dependencyGraphEngine.upsertEdge({ ...body(req), id: req.params.id } as never)); } catch (error) { handle(error, res); }
});
router.get("/new-engines/dependencies/:id", (req, res) => res.json(dependencyGraphEngine.dependencies(req.params.id, req.query.direction === "downstream" ? "downstream" : "upstream")));
router.get("/new-engines/dependencies/cycles", (_req, res) => res.json({ cycles: dependencyGraphEngine.cycles() }));
router.post("/new-engines/dependencies/plan", (req, res) => {
  try { res.json(dependencyResolutionEngine.plan((body(req).nodeIds ?? []) as string[])); } catch (error) { handle(error, res); }
});

// N11 — Digital Twin and state projections.
router.post("/new-engines/twin/events", (req, res) => {
  try { res.status(201).json(digitalTwinEngine.append(body(req) as never)); } catch (error) { handle(error, res); }
});
router.post("/new-engines/twin/project", (req, res) => {
  try {
    const input = body(req);
    const reducer = (state: JsonObject, event: { payload: JsonObject }) => ({ ...state, ...event.payload });
    res.json(digitalTwinEngine.project(String(input.aggregateType), String(input.aggregateId), reducer));
  } catch (error) { handle(error, res); }
});
router.get("/new-engines/twin/:type/:id/drift", (req, res) => res.json(digitalTwinEngine.drift(req.params.type, req.params.id, (req.query.expected ? JSON.parse(String(req.query.expected)) : {}) as JsonObject)));

// N12 — Controlled remediation.
router.post("/new-engines/remediation/actions", (req, res) => {
  try { res.status(201).json(remediationEngine.registerAction(body(req) as never)); } catch (error) { handle(error, res); }
});
router.post("/new-engines/remediation/policies", (req, res) => {
  try { res.status(201).json(remediationEngine.registerPolicy(body(req) as never)); } catch (error) { handle(error, res); }
});
router.post("/new-engines/remediation/execute", async (req, res) => {
  try {
    const input = body(req);
    res.json(await remediationEngine.execute(
      String(input.policyId),
      (input.context && typeof input.context === "object" && !Array.isArray(input.context) ? input.context : {}) as JsonObject,
      {
        dryRun: Boolean(input.dryRun),
        approved: Boolean(input.approved),
        actor: req.user?.userId == null ? undefined : { userId: req.user.userId },
        idempotencyKey: typeof input.idempotencyKey === "string" ? input.idempotencyKey : undefined,
      },
    ));
  } catch (error) { handle(error, res); }
});
router.get("/new-engines/remediation/history", (_req, res) => res.json(remediationEngine.history()));

// N13 — Impact Analysis.
router.post("/new-engines/impact/analyze", (req, res) => {
  try { res.json(impactAnalysisEngine.analyze(body(req) as never)); } catch (error) { handle(error, res); }
});

// N14 — Optimization.
router.post("/new-engines/optimization", (req, res) => {
  try { res.json(optimizationEngine.optimize(body(req) as never)); } catch (error) { handle(error, res); }
});

// N15 — Decision support remains separate from authorization.
router.post("/new-engines/decisions", (req, res) => {
  try { res.status(201).json(decisionIntelligenceEngine.decide(body(req) as never)); } catch (error) { handle(error, res); }
});
router.get("/new-engines/decisions/:id", (req, res) => {
  const result = decisionIntelligenceEngine.get(req.params.id);
  if (!result) { res.status(404).json({ error: "Decision not found", code: "NOT_FOUND" }); return; }
  res.json(result);
});

// Exposed only for diagnostics/tests; it is not a bypass around the route
// permission check and contains no secret material.
router.get("/new-engines/health", (_req, res) => res.json({
  engines: ["N1", "N2", "N3", "N4", "N5", "N6", "N7", "N8", "N9", "N10", "N11", "N12", "N13", "N14", "N15"],
  records: {
    search: newEngineStore.searchDocuments.size,
    graphNodes: newEngineStore.graphNodes.size,
    lineage: newEngineStore.lineage.size,
    provenance: newEngineStore.provenance.size,
  },
}));

export default router;