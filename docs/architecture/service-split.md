# AYZEN server split

## Runtime topology

```text
Web / Telegram / Admin clients
              |
       apps/api-gateway :5000
              |
     +--------+------------------+
     |                           |
 compatibility monolith :8080   extracted service processes
                                  finance :8101
                                  vault :8102
                                  wisp/mail :8103
                                  notification :8104
                                  workflow :8105
                                  ai :8106
                                  marketplace :8107
                                  search :8108
                                  intelligence :8109
                                  admin :8111
```

The gateway owns public routing, request forwarding, timeout handling, and
route-mode headers. It has no business SQL or domain authorization logic.
The monolith remains the default target for every route family.

## Strangler routing

Each route family has a corresponding environment variable:

| Route | Environment variable | Default |
| --- | --- | --- |
| `/api/finance` | `FINANCE_SERVICE_URL` | monolith |
| `/api/vault` | `VAULT_SERVICE_URL` | monolith |
| `/api/mail` | `WISP_SERVICE_URL` | monolith |
| `/api/notifications` | `NOTIFICATION_SERVICE_URL` | monolith |
| `/api/workflows` | `WORKFLOW_SERVICE_URL` | monolith |
| `/api/ai` | `AI_SERVICE_URL` | monolith |
| `/api/marketplace` | `MARKETPLACE_SERVICE_URL` | monolith |
| `/api/search` | `SEARCH_SERVICE_URL` | monolith |
| `/api/intelligence` | `INTELLIGENCE_SERVICE_URL` | monolith |
| `/api/admin` | `ADMIN_SERVICE_URL` | monolith |

The gateway reports the active mapping at `/internal/routes`. Every extracted
service exposes `/health`, `/live`, `/ready`, and `/internal/manifest`.

## Boundary rules

1. Clients call the gateway, never a service URL.
2. Services communicate through versioned event envelopes and signed internal
   requests; service request replay protection remains in the existing
   database-backed middleware.
3. Service packages must not import `artifacts/api-server`.
4. A route is not switched by deployment alone. The migration registry still
   requires backup, characterization, backfill, validation, and rollback gates.
5. Until domain handlers and owned-schema adapters are moved, the standalone
   service responds with an explicit not-implemented response rather than
   pretending to own business behavior.