# AYZEN phases 11–30 implementation

Status: **repository controls implemented; provider deployment is an explicit
handoff input**.

The 0–30 closure also includes the complete shared Telegram interface
contract. All eight product bots have app-specific command groups, while the
Admin bot is a separate privileged surface. Menus are layered
`app → module → resource → action`, hidden actions are permission-aware,
callbacks are HMAC-signed, expiring, and guarded for single use, and sessions
bind bot, numeric Telegram user, and workspace. Telegram handlers dispatch
through the capability/endpoint registry and never contain domain business
logic.

The roadmap phases 11–30 are represented by one deployable catalog and one
promotion contract. This keeps the hybrid architecture economical: the
workloads are independently versioned and health-checked, while the runtime
may co-locate them until measured isolation or scaling needs justify a split.

| Phase | Implemented evidence |
| --- | --- |
| 11 — Repository build matrix | `scripts/detect-affected.mjs` maps changed source/shared packages to affected deployables. |
| 12 — Container standardization | `infrastructure/docker/Dockerfile` is multi-stage, prunes production dependencies, runs as `node`, emits OCI metadata, and has a health check. |
| 13 — Artifact supply chain | `scripts/release-manifest.mjs`, the immutable tag/digest policy, and the release workflow record exact source and image identity. |
| 14 — Infrastructure as code | `infrastructure/iac/README.md` defines the versioned provider-neutral contract and the non-fabricated provider handoff. |
| 15 — Managed runtime | `infrastructure/deployment/runtime-definition.json` defines shared managed runtime groups, network placement, dependencies, and workload requirements. |
| 16 — Networking/ingress | Runtime definition limits public exposure to the gateway and Telegram webhook workload; service routes remain private behind the gateway. |
| 17 — Environment/secrets | `environment.schema.json` and `scripts/validate-env.mjs` separate profiles and require secret names without storing values. |
| 18 — Quality gates | CI runs syntax, boundary, service, API-server, build, cloud-phase, and production-readiness checks. |
| 19 — Security supply chain | `.github/workflows/security.yml` runs dependency, secret-pattern, SAST, architecture, and image scan gates. |
| 20 — Database CI/CD | Promotion policy requires migration checks; existing staging/runbook rules require backup, expand/contract validation, and rollback evidence. |
| 21 — EventBus CI/CD | Existing versioned event envelopes plus CI boundary checks are required gates; EventBus compatibility remains independently deployable. |
| 22 — Workflow CI/CD | Workflow is a catalogued deployable with health, pause/rollback behavior, and the promotion gate includes workflow validation. |
| 23 — Telegram CI/CD | Telegram gateway is a catalogued deployable with webhook smoke coverage and secret-managed webhook validation. |
| 24 — Preview/staging | `infrastructure/staging/smoke.sh` validates the staged gateway and route/capability surfaces without production data. |
| 25 — Automated promotion | Release workflow builds once, publishes an immutable candidate, generates a release manifest, and requires staged approval before promotion. |
| 26 — Health/smoke tests | Standard probes are required in the catalog, Docker health checks, runtime endpoints, and staging smoke script. |
| 27 — Progressive delivery | Promotion policy and rollback contract support rolling/canary/blue-green provider adapters without changing application contracts. |
| 28 — Rollback/DR | `infrastructure/rollback/README.md` defines immutable image rollback, forward-fix database rules, worker draining, and restore evidence. |
| 29 — Intelligence integration | Deployment/runtime identifiers are carried in release manifests and structured runtime telemetry; the intelligence service is a catalogued consumer. |
| 30 — Maturity gate | `scripts/validate-cloud-phases.mjs` rejects missing owner, image/runtime metadata, health, secret, rollback, permissions, or workflow evidence. |

## Provider boundary

The repository cannot safely invent a cloud account, registry, DNS record,
managed database, event bus, or workload identity. A provider adapter consumes
the catalog and runtime definition after those deployment inputs are supplied.
The CI workflow still builds and validates the exact artifact that adapter must
deploy.