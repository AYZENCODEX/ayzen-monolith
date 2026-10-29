# Authorization and zero-trust assurance

Protected actions default to deny and are evaluated through the capability
policy. The matrix records negative cases that must remain denied and marks
audit as mandatory for authorization decisions.

The static evidence is `config/antas/authorization-matrix.json`,
`packages/authorization/src/index.mjs`, and the cross-app authorization tests.
Staging endpoint exercises are required before production certification.