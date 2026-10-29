# Domain ownership

Every domain has one accountable owner for its API, data, migrations, events,
authorization boundary, audit trail, and operations. The machine-readable
registry is `config/antas/domain-ownership.json`; the runtime contract source
is `packages/domain-boundaries/src/index.mjs`.

Private service repositories and arbitrary cross-domain database access are
not public contracts. Boundary checks run through
`scripts/validate-domain-boundaries.mjs`.