# Identity data ownership

Identity, local app accounts, profiles, sessions, links, and authorization
have explicit owners. The current deployment may use one PostgreSQL cluster,
but logical ownership and owner-mediated access are enforced before any
physical database split.