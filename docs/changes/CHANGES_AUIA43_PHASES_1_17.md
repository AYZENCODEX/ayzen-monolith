# AUIA43 phases 1–17 implementation record

This document records the engineering decisions made while closing the
deterministic parts of the AUIA43 audit. The attached roadmap remains the
detailed audit source; this file prevents deployment-dependent decisions from
being mistaken for missing code.

## Closed in the repository

- **Phase 1:** CI, security, release, reusable-service, and scheduled audit
  workflows now exist. They install from the frozen lockfile, run the
  validators, build affected deployables, perform dependency and secret
  checks, and use image provenance/SBOM build settings.
- **Phase 2:** identity remains a foundational monolith-backed proxy and has
  no event-client dependency or event-bus usage, so its inaccurate
  `eventBus` declaration was removed rather than wiring an unused dependency.
  Search is a real event-bus service and is now present in compose. Identity is
  deliberately outside the strangler route matrix until a separate identity
  cutover design exists.
- **Phase 3:** the workspace lockfile and library typecheck are CI gates. The
  full workspace typecheck still reports the pre-existing API/scripts
  TypeScript baseline (150 errors, mostly route resource-ref inference and
  project-boundary configuration) and is recorded rather than hidden.
- **Phase 5:** `mail.delivery.updated` remains a provider-specific future
  feature, not a promised event. Alert ownership remains with the alerting
  package; administrative consumers do not become producers. The nonexistent
  `incident` service is not introduced merely to satisfy a registry label.
- **Phase 6:** the three legacy event projections are retained as
  non-authoritative compatibility inputs for the roadmap validator family.
  Live event contracts in `packages/events` and
  `packages/domain-boundaries` are authoritative.
- **Phase 7:** the domain-contract baseline remains explicit: platform is
  infrastructure-only, authorization is policy-only, and the unresolved
  operations include non-HTTP operations or vocabulary that the fuzzy checker
  cannot resolve. New drift is still rejected.
- **Phase 8:** proxy-aware client-IP resolution and bounded rate-limit state
  were already present and are preserved. Compose now supplies the trusted
  proxy hop count to every relevant service.
- **Phase 9:** the SSE route no longer overrides the application's allowlist
  with a wildcard.
- **Phase 10:** the lease/scheduler/policy modules are retained as reference
  governance components. The production schedule path remains the workflow
  service plus worker trigger, so no second scheduler runtime is started.
- **Phase 11:** the Redis event client already owns retry and dead-letter
  storage/replay. Worker dispatch now rethrows after a failed consumer so the
  bus can retry and eventually dead-letter instead of acknowledging a failed
  event.
- **Phase 12:** notification creation now consults durable preferences and
  quotas before invoking a provider. The in-app provider is the honest local
  provider; unsupported channels fail explicitly. Policy state can be seeded
  with `NOTIFICATION_PREFERENCES_JSON` and `NOTIFICATION_QUOTAS_JSON` or
  managed through the internal policy routes.
- **Phases 15–16:** the monolith image no longer rebuilds during container
  startup, and the Docker healthcheck uses the service's `PORT` before the
  image fallback port.
- **Phase 17:** compose includes identity and search, routes identity/search
  through the gateway, and supplies a JWKS URL and issuer to extracted
  services. Services emit an explicit startup warning when bearer-token JWKS
  configuration is absent.

## Explicit external actions

These cannot be truthfully completed from a static repository checkout:

1. Run a report-mode observation window for `CAPABILITY_AUTHZ_GATE` against
   production traffic, then set `CAPABILITY_AUTHZ_GATE=enforce`.
2. Confirm the production identity issuer, JWKS hostname, and deployment
   topology; the compose values are the local reference topology and must not
   silently become production configuration.
3. Run an authenticated gateway-to-service smoke test with a real token
   issued by that identity deployment.
4. Choose the notification preference/quota system of record for production
   if it should be separate from the notification service's durable state.
5. Choose whether the reference governance modules should later be promoted
   into a deployed shared runtime or retired after the production scheduler
   and policy ownership are formally approved.
