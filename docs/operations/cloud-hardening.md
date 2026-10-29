# Cloud hardening

The provider-neutral deployment contract is defined by
`infrastructure/deployment/service-catalog.json`,
`runtime-definition.json`, `topology.yaml`, and `environment.schema.json`.

Deployables run as non-root containers with a healthcheck, explicit ports,
bounded resources, least-privilege service permissions, and no credentials in
images or source. Production secrets are injected by the provider secret
manager. The local Compose file is for synthetic staging rehearsal only.