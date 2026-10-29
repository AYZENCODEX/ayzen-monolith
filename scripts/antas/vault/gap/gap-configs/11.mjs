// Config for scripts/antas/vault/gap/validate-gap.mjs — VLT-GAP-11 (Health / operations).
import path from "node:path";
const API = "artifacts/api-server/src";
const APP = `${API}/vault/application`;
const ROUTE_VAULT = `${API}/routes/vault.ts`;
// Health rules were already extracted into vault/application/health.ts (lib/vault-health.ts is only a compat shim).
// Remaining owners: the daily scan (DB reads, flag writes, notification/telegram/email digest) and its cron wiring.
const moves = {
  [`${API}/lib/vault-health-scan.ts`]: `${APP}/health-scan.ts`,
  [`${API}/lib/vault-health-cron.ts`]: `${APP}/health-cron.ts`,
};
// toHealthInput is health-domain: formatted entity -> health rule input. It lived in routes/vault.ts "until GAP-11"
// (see the deferral note in the scan), which made the scan import a route module.
const symbolMoves = [{ from: ROUTE_VAULT, name: "toHealthInput", to: `${APP}/health.ts` }];
export default {
  gap: "VLT-GAP-11", dir: "reports/antas/vault/gap/VLT-GAP-11", api: API,
  differential: "scripts/antas/vault/gap/differential-vlt-gap-11.mjs",
  // routes/health.ts is the platform liveness probe (GET / and /healthz -> {status:"ok"}); it holds no Vault health logic and stays as is.
  moves, routes: {}, symbolMoves, repositories: [], extraOwners: [], extraSources: [ROUTE_VAULT],
  allowedRouteImporters: [`${API}/routes/index.ts`, `${API}/vault/api/index.ts`],
  forbiddenInRoute: [], maxRouteLines: 200,
  typecheckExtra: [`${API}/index.ts`, `${API}/routes/vault.ts`, `${API}/vault/application/index.ts`, `${API}/vault/infrastructure/index.ts`],
  mapRows: () => [
    ...Object.entries(moves).map(([o, n]) => `| Vault ${path.basename(o, ".ts").replace("vault-", "")} | \`${o}\` | \`${n}\` | RETIRED (VLT-GAP-11); moved unchanged, old file removed |`),
    `| Vault health input mapping (toHealthInput) | \`${ROUTE_VAULT}\` | \`${APP}/health.ts\` | EXTRACTED (VLT-GAP-11); body unchanged |`,
  ],
};
