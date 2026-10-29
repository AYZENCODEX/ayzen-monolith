# API security backbone

Protected API requests establish correlation context before routing, parse
authentication through the shared auth middleware, resolve tenant/workspace
access, evaluate policy/capability requirements, and emit an audit decision.
Public probes and OIDC discovery are deliberately separate from protected
application routes.

Negative behavior is fail-closed for missing credentials, missing scope,
cross-tenant access, invalid step-up state, and invalid service credentials.