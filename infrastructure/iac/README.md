# Infrastructure as code contract

The repository uses a provider-neutral managed-container contract until the
deployment owner selects a cloud provider. This avoids committing a provider
endpoint, account identifier, network range, or credential that cannot be
verified from the repository.

The versioned inputs are:

- `infrastructure/deployment/service-catalog.json`: deployable ownership,
  ports, health probes, dependencies, and rollback strategy.
- `infrastructure/deployment/runtime-definition.json`: public/private network
  placement, shared-runtime policy, and required workload metadata.
- `infrastructure/deployment/environment.schema.json`: environment profiles
  and secret names; values come from the provider secret manager.
- `infrastructure/deployment/promotion-policy.json`: immutable artifact and
  promotion gates.

The provider adapter must translate these files to the selected managed
container runtime. It must preserve the following invariants:

1. Public ingress is limited to the gateway and Telegram webhook workload.
2. Internal traffic uses service authentication and propagated request context.
3. Each workload runs as a non-root user with `/health`, `/ready`, and `/metrics`.
4. Production deploys an image digest, not a mutable tag.
5. Secrets are referenced by name from the provider secret manager.
6. Rollback restores the route fallback or prior immutable image before any
   destructive data recovery.

## Fresh-environment handoff

The deployment owner supplies the provider adapter, registry hostname,
managed database/event-bus endpoints, DNS, and workload identity binding.
Those are intentionally not fabricated in this repository. The CI release
workflow builds and signs the immutable candidate; the adapter consumes its
release manifest and digest.