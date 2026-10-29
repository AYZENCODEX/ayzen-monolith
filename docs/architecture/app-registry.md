# App registry

The canonical app registry is `config/api/app-registry.json`. Each app has an
owner, API boundary, authorization policy, data boundary, and observability
context. Cross-app access is a governed API or event operation; direct
cross-app database access is denied by default.