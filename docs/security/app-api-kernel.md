# App API security kernel

`@ayzen/app-api-security` binds a request to one app, authenticated principal,
tenant, trace context, and optional service identity. Authorization is
default-deny, server-side, capability-based, and can require step-up.
Request metadata can be signed and verified with an app/service secret.