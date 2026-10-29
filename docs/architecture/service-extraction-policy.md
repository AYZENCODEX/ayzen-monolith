# Selective service extraction policy

AYZEN extracts a module only when at least one measurable requirement justifies
the operational cost: independent scaling, deployment, security isolation,
failure isolation, or independent ownership.

An extraction proposal must include measured load, a data ownership boundary,
versioned contracts, health/readiness behavior, rollback, an on-call owner and
a cost estimate. It must be approved by the domain, platform and security
owners. The proposal is rejected when the motivation is service count,
duplicate shared infrastructure, or shared database access.

The machine-readable criteria live in
`infrastructure/platform/extraction-rules.json`.