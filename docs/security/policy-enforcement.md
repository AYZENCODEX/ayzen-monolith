# Policy and PEP enforcement

Policies are versioned contracts. A policy decision is not sufficient by
itself: the route or service must enforce the decision before a protected
side effect. Denials are observable and audited without exposing secrets.

Use `pnpm run validate:policy-contract` and `pnpm run validate:enforcement`
after changing policy, capability, or route registries.