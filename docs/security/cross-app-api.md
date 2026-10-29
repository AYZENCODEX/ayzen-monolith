# Cross-application API boundary

Cross-application calls use the API gateway or the governed event bus. Direct
database access between applications is forbidden. The caller must provide a
tenant scope, trace and correlation identifiers, a declared audience, a
capability scope, and an auditable resource decision.

The gateway may route to an extracted service only when the route is present in
the endpoint registry and the service has an explicit environment URL. If the
extracted service is unavailable, safe read traffic may fall back to the
monolith; writes return an explicit upstream error rather than silently
changing ownership.

Service-to-service calls use the signed AYZEN request headers and a shared
secret delivered by the deployment secret manager. User bearer tokens are
verified against the configured JWKS endpoint at the receiving service.
Responses must not expose credentials, raw tokens, or another application's
private storage records.
