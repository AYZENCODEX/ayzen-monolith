# Shared platform boundaries

AYZEN uses one shared platform runtime with logical application isolation. The
API gateway, event fabric, workflow runtime, scheduler, notification service,
policy decision point, identity, coordination, quotas, health, audit and
operator controls are shared capabilities. They are not copied per app.

Business domains and their databases remain app-owned. The compatibility
monolith may call governed services through API or EventBus contracts; an
extracted service may not reach into monolith internals or another app's
database. The default cross-app database policy is deny.

Every shared capability and app-owned service is registered with an owner,
source, lifecycle, health/readiness endpoints, dependencies, contracts,
security context and recovery behavior. An item can become `ACTIVE` only after
the phase 1–30 validators report no critical finding.

## Ownership rules

| Boundary | Shared runtime | App-owned definition/data |
| --- | --- | --- |
| EventBus | transport, delivery, retry, DLQ, replay | event types, producers, consumers |
| Workflow | execution, worker capacity, recovery | workflow definitions and data scope |
| Scheduler | triggers, leases, duplicate prevention | schedules and target workflows |
| Notification | provider adapters and delivery state | templates, preferences and policies |
| Policy | decision contract and audit | app roles, capabilities and resources |
| Config/secrets | namespace, validation, rotation, drift | app/service values and references |

The catalog in `infrastructure/platform/shared-service-catalog.json` is the
machine-readable source of truth.