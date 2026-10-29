# Security model

AYZEN uses layered controls: transport security middleware, authenticated
identity context, tenant/workspace authorization, policy decision points,
policy enforcement points, capability scopes, step-up checks for sensitive
actions, audit integrity, and bounded rate limiting.

SIORA and intelligence components provide risk and context signals. They do
not replace the policy decision point or grant authorization. Admin and
break-glass actions remain explicitly scoped, audited, and tenant-bound.