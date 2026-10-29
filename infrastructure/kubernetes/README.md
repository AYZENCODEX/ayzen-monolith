# Kubernetes deployment notes

The production deployment should run one Deployment per process boundary,
with separate readiness and liveness probes:

```text
GET /live   liveness
GET /ready  readiness
GET /metrics monitoring
```

Use immutable image tags, a PodDisruptionBudget for replicated services,
resource requests/limits, network policies, and an external secret manager.
The repository intentionally does not include cluster-specific manifests:
namespace, ingress, storage, and identity-provider details are deployment
inputs, not safe defaults.