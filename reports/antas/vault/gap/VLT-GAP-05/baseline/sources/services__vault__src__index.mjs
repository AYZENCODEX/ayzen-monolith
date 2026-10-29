import {
  createConfiguredAuthenticator,
  createServiceServer,
} from "@ayzen/service-runtime";
import { createVaultCrypto } from "./crypto/envelope.mjs";
import { createVaultAccess } from "./security/access.mjs";
import { createVaultDependencies } from "./infrastructure/dependencies.mjs";
import { createVaultHttpHandler } from "./api/http-handler.mjs";
import { VAULT_CONTRACT } from "./api/contracts.mjs";

// Phase H6.2: durable, Postgres-backed state instead of a plain
// Map() that a restart/redeploy would wipe. Falls back to an
// in-memory Map only when ALLOW_SERVICE_MEMORY_STORE=true (local dev);
// otherwise a missing DATABASE_URL is a boot-time error, not a silent
// data-loss risk.
const allowMemoryState = process.env.ALLOW_SERVICE_MEMORY_STORE === "true";
const dependencies = await createVaultDependencies({ allowMemoryState });
const vaultCrypto = createVaultCrypto(process.env.SYLO_MASTER_KEY);
const vaultAccess = createVaultAccess();
const handle = createVaultHttpHandler({ ...dependencies, vaultCrypto, vaultAccess });

createServiceServer({
   service: VAULT_CONTRACT.service,
   displayName: VAULT_CONTRACT.displayName,
   port: Number(process.env.PORT ?? 8102),
   routePrefixes: VAULT_CONTRACT.routePrefixes,
  handle,
  authenticate: createConfiguredAuthenticator({ service: "vault", required: process.env.VAULT_AUTH_REQUIRED === "true" }),
  domain: "vault",
  owner: "SYLO",
   ownedResources: VAULT_CONTRACT.ownedResources,
   emittedEvents: VAULT_CONTRACT.events,
  rollbackStrategy: "disable VAULT_SERVICE_URL; retain encrypted records and audit trail",
  dependencies: { configuration: true, encryption: true, audit: true, eventBus: true },
}).start();