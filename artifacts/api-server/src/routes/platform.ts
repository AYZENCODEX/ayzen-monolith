import { Router } from "express";
import { requireDev } from "../middlewares/auth";
import { SERVICE_DESCRIPTORS } from "../lib/architecture/domains";
import { getOwnedTables } from "../lib/service-boundaries";
import { getTelegramBotStatus } from "../lib/telegram-bot-registry";
import { DOMAIN_SERVICE_CONTRACTS } from "../lib/domain-service-contracts";
import { requireServiceRequest } from "../lib/service-to-service-security";
import { getMigrationReadiness } from "../lib/migration-registry";
import { getRoadmapReadiness, ROADMAP_PHASES_10_25, getRegisteredEventTypes } from "../lib/roadmap-contracts";

const router = Router();

/** Internal architecture visibility; never exposes tokens or secret values. */
router.get("/platform/architecture", requireDev, (_req, res): void => {
  res.json({
    migration: "modular-monolith",
    services: SERVICE_DESCRIPTORS.map((service) => ({
      ...service,
      ownedTables: getOwnedTables(service.key),
    })),
    telegramBots: getTelegramBotStatus().map(({ tokenEnvVar, webhookSecretEnvVar, ...bot }) => ({
      ...bot,
      tokenConfigured: Boolean(process.env[tokenEnvVar]),
      webhookSecretConfigured: Boolean(process.env[webhookSecretEnvVar]),
    })),
    contracts: DOMAIN_SERVICE_CONTRACTS,
  });
});

/**
 * Internal roadmap visibility for operators and CI smoke checks. This endpoint
 * reports metadata and readiness only; it never exposes credentials, payloads,
 * mailbox contents, or Vault values.
 */
router.get("/platform/roadmap", requireDev, (_req, res): void => {
  res.json({
    roadmap: "AYZEN Implementation Roadmap V2",
    phases: ROADMAP_PHASES_10_25,
    readiness: getRoadmapReadiness(),
    migration: getMigrationReadiness(),
    registeredEventTypes: getRegisteredEventTypes(),
  });
});

// Service-to-service probe. It is signed with the shared internal secret and
// replay-protected by a durable nonce, so this route is not a substitute for
// end-user authentication or a public health endpoint.
router.post("/platform/internal/health", requireServiceRequest, (req, res): void => {
  res.json({
    ok: true,
    service: req.header("x-ayzen-service"),
    requestId: req.header("x-ayzen-request-id"),
    timestamp: new Date().toISOString(),
  });
});

export default router;