# XUKA remaining phase completion

The attached renumbered roadmap contains phases 1–156. The repository keeps
those phases registered in `packages/xuka/src/index.mjs` and validates the
implementation surface through:

```text
node scripts/validate-xuka-1-80.mjs
node scripts/validate-xuka-81-156.mjs
node scripts/validate-xuka-completion.mjs
```

The completion gate is deliberately split:

- phases 1–12 use the beta migration registry and deterministic migration
  runner;
- phases 13–20 use the endpoint, API, gateway, error, idempotency, and
  correlation contracts;
- phases 21–30 use the Telegram catalog, owner check, receipt reliability, and
  routing controls;
- phases 39–57 use the database ownership, shared-data, scope, app-policy, and
  OIDC boundaries;
- phases 58–65 use the event schema, workflow, retry, DLQ, audit, and bypass
  controls;
- phases 66–71 use canonical context and tenant propagation;
- phases 72–141 use the resource, dependency, configuration, flag, state,
  quota, discovery, lifecycle, credential, compatibility, and graph engines;
- phases 142–156 use production-gap and frontend verification plans.

The cross-channel, cross-app, and cross-bot fabric is an additional shared
control used by the integration and production-gap phases. It permits only API
or eventbus transport, requires tenant and trace context, and rejects
unregistered endpoints, scopes, resources, and duplicate event deliveries.

“Complete” here means repository-level contracts and deterministic controls
are present. Provider credentials, external channel adapters, deployment
configuration, real-data migration evidence, and authorized production
sign-off remain deployment inputs.