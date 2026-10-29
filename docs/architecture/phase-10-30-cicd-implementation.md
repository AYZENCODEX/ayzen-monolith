# AYZEN phases 10–30 CI/CD implementation

The CI/CD development path is now encoded as a build-once, promote-by-digest
pipeline:

```text
Pull request
  -> changed deployable detection
  -> reusable affected-service matrix
  -> syntax / type / boundary / API / EventBus / Workflow / Telegram checks
  -> dependency / secret / SAST / container checks
  -> immutable image with provenance + SBOM
  -> staging smoke + health/readiness
  -> approval gate
  -> provider deployment handoff
  -> release event / intelligence / rollback
```

## Phase coverage

- **10 — CI/CD foundation:** `.github/workflows/ci.yml`,
  `.github/workflows/release.yml`, `.github/workflows/security.yml`,
  `.github/CODEOWNERS`, and the pull-request template define protected
  validation, security, artifact, and promotion stages.
- **11 — Build matrix:** `scripts/detect-affected.mjs` emits a JSON deployable
  matrix. The reusable service workflow builds only affected catalog entries,
  while shared package changes intentionally fan out to all deployables.
- **12–13 — Containers and supply chain:** the multi-stage non-root Dockerfile
  has a health check and OCI metadata. Build provenance, SBOM, commit tags, and
  digests are required by the release workflow.
- **14–17 — Runtime/IaC/network/secrets:** the service catalog,
  runtime-definition, environment schema, and provider-neutral IaC handoff
  define public/private placement and secret references without fabricating
  provider credentials.
- **18–23 — Quality and backbone gates:** CI invokes existing phase validators
  plus the cloud/platform/maturity validators. The promotion policy explicitly
  includes database, EventBus, Workflow, Telegram, contract, and container
  checks.
- **24–30 — Staging, promotion, health, rollback, and intelligence:** staging
  smoke scripts, release manifests, promotion policy, rollback contract, and
  deployment events keep the same approved artifact traceable through runtime
  health and intelligence.

The provider-specific deploy step remains a deliberate handoff because account,
registry, DNS, managed database/event bus, and workload identity values are
deployment inputs, not safe repository defaults.