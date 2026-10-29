# Monolith and microservice contract boundary

The monolith is a compatibility runtime, not an authority that extracted
services may reach into. The allowed boundary is a versioned API or a governed
EventBus event carrying identity, tenant scope, policy context, trace context
and an auditable operation.

Services own their data. Direct reads or writes to the monolith database or
another app database are blocked by default. An exception must be represented
as an explicit, time-bounded contract and approved by platform and security
owners; it is not an implicit import or connection string.

All long-running work enters the shared workflow/worker fabric. All scheduled
work enters the shared scheduler and lease layer.