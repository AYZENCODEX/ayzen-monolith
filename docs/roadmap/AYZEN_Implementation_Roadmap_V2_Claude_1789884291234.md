# AYZEN Implementation Roadmap V2
## Production Microservices + 8 Telegram Bots + Personal/Business Workspace + WISP Mailbox

### Bots
1. AYZENX — Personal Workspace
2. WARDE — Organization / Business Workspace
3. VERVE — Communication / Productivity
4. RYFT — Finance
5. SYLO — Secure Storage / Vault
6. SKARN — Automation / Workflow
7. ZYNTH — AI / Intelligence / Agent
8. WISP — Mailbox / Email

## Strategy
Existing modular monolith → hardened modular monolith → selective service extraction → event-driven hybrid → production microservices.

**Do not perform a big-bang rewrite.** A route/folder is not automatically a service. A service must represent a meaningful business domain.

---

# PHASE 0 — Repository Discovery & Baseline
**Purpose:** Understand the actual AYZEN codebase before changing it.

Inspect applications, routes, frontend, domains, database/migrations, authentication, authorization, queues, schedulers, WebSockets, storage, mail, notifications, finance, vault, AI, marketplace, search, integrations, audit, logs, tests, environment variables and deployment.

**Deliverables**
```text
docs/architecture/current-state.md
docs/architecture/domain-map.md
docs/architecture/dependency-map.md
docs/architecture/data-flow.md
docs/architecture/security-boundary.md
docs/architecture/migration-plan.md
docs/inventory/routes.md
docs/inventory/database.md
docs/inventory/integrations.md
```

**Exit:** Complete domain/dependency inventory; no unnecessary production changes.

---

# PHASE 1 — Domain Boundaries
**Purpose:** Define clean ownership before extraction.

Target domains:
```text
Identity
Authorization
Workspace
User
Finance
Vault
Workflow
WISP Mailbox
Mail Delivery
Notification
AI/Agent
Marketplace
Search/Knowledge
Analytics
```

For each domain document responsibility, owned data, API, events, permissions, dependencies and failure modes.

**Exit:** Every major domain has explicit ownership.

---

# PHASE 2 — Monorepo & Shared Platform Foundation
**Purpose:** Allow monolith and future services to coexist.

Target:
```text
apps/
  web/ admin/ gateway/ telegram-gateway/

services/
  identity/ authorization/ workspace/ user/
  finance/ vault/ workflow/ wisp/
  mail/ notification/ ai/ marketplace/
  search/ analytics/

packages/
  auth/ contracts/ api-client/ api-spec/
  events/ telegram/ policy/ logger/
  telemetry/ tracing/ errors/ config/ types/

infrastructure/
  docker/ kubernetes/ terraform/ monitoring/ secrets/

tests/
  unit/ integration/ contract/ security/ e2e/ load/
```

Move incrementally. Shared packages must not become a dumping ground for business logic.

---

# PHASE 3 — Security Baseline
**Purpose:** Harden security before distributed architecture increases the attack surface.

Preserve/strengthen:
- RS256 JWT
- JWKS and `kid`
- algorithm pinning
- key rotation
- session revocation
- refresh-token rotation
- MFA/passkeys/OIDC where supported
- CSRF/CORS/CSP/security headers
- SSRF, injection, path traversal and upload protection
- rate limiting and brute-force protection
- safe production errors

Never expose passwords, private keys, bot tokens, encryption keys, vault plaintext or raw DB/stack errors.

---

# PHASE 4 — Identity Service
**Purpose:** Separate authentication from business domains.

`services/identity`

Own:
- users
- credentials
- sessions
- refresh tokens
- MFA
- passkeys
- OIDC
- recovery
- token issuance/revocation

Core API:
```text
POST /auth/login
POST /auth/refresh
POST /auth/logout
POST /auth/revoke
GET /.well-known/jwks.json
```

Other services verify tokens with public keys/JWKS; they do not query the Identity DB on every request.

---

# PHASE 5 — Workspace & Multi-Tenancy
**Purpose:** Make personal and organization/business contexts first-class.

Model:
```text
User
 ├── Personal Workspace → AYZENX
 └── Organizations → WARDE
```

Entities:
```text
Workspace
WorkspaceMember
Organization
OrganizationMember
Role
Permission
Resource
```

Types:
```text
PERSONAL
ORGANIZATION
BUSINESS
```

Server-side workspace isolation is mandatory.

---

# PHASE 6 — Authorization / Policy Platform
**Purpose:** One authorization model for Web, Admin, Telegram and AI.

```text
Central Policy
      ↓
Policy Cache/Distribution
      ↓
Local Policy Enforcement Point
      ↓
Domain Service
```

Support RBAC, resource ownership, workspace/org membership, bot capabilities, service permissions and step-up authorization.

Avoid a remote authorization call on every request when safe local enforcement/caching is possible.

---

# PHASE 7 — API Gateway
**Purpose:** Public HTTP boundary.

Responsibilities:
- routing
- JWT verification
- request/correlation IDs
- rate limiting
- CORS
- API versioning
- validation
- timeout handling
- safe retries
- response normalization

No business logic in the gateway.

```text
Internet → CDN/WAF/TLS → API Gateway → Domain Services
```

---

# PHASE 8 — Telegram Gateway & Bot Registry
**Purpose:** One shared infrastructure layer for all 8 bots.

Create:
```text
apps/telegram-gateway
packages/telegram
```

Bot Registry stores:
- bot ID
- Telegram bot ID
- secret reference
- capabilities
- workspace type
- permissions
- status
- command registry

Bots:
```text
AYZENX
WARDE
VERVE
RYFT
SYLO
SKARN
ZYNTH
WISP
```

**Critical rule:** Telegram Bot = channel/interface. Domain Service = business logic.

Telegram handlers must not contain direct business SQL/domain logic.

---

# PHASE 9 — Telegram Identity, Context & Security
**Purpose:** Secure the Telegram channel.

Resolve every request as:
```text
Telegram User + Bot + Workspace + Command + Permission
→ Authorized Context
```

Implement:
- update-id idempotency
- webhook validation
- account linking
- bot capability checks
- per-user/chat/bot rate limits
- sensitive-command confirmation
- audit metadata

Finance, Vault and privileged organization actions may require step-up authentication.

---

# PHASE 10 — Event Bus
**Purpose:** Reliable asynchronous communication.

Possible infrastructure:
```text
NATS / RabbitMQ / Redis Streams / Kafka
```

Use actual requirements to choose.

Core concepts:
- event ID
- correlation ID
- schema version
- producer/consumer
- retry
- DLQ
- idempotency

Example events:
```text
workspace.created
workspace.member.added
finance.transaction.created
vault.secret.accessed
workflow.completed
wisp.message.received
wisp.message.sent
notification.sent
ai.task.completed
```

---

# PHASE 11 — Outbox & Distributed Reliability
**Purpose:** Prevent DB-success/event-loss inconsistencies.

```text
DB Transaction
 ├── Business Data
 └── Outbox Event
        ↓
   Outbox Worker
        ↓
     Event Bus
```

Also implement idempotency keys, exponential backoff, jitter, DLQ, timeouts and graceful shutdown.

Never blindly retry non-idempotent financial operations.

---

# PHASE 12 — Finance Service / RYFT
**Purpose:** Extract finance as an independently owned domain.

`services/finance`

Own:
- accounts
- transactions
- income
- expenses
- budgets
- invoices
- investments
- categories
- reports

RYFT commands may include:
```text
/expense
/income
/balance
/budget
/transaction
/report
```

Use strict workspace authorization, audit trails, idempotency, transaction integrity and concurrency control.

---

# PHASE 13 — Vault Service / SYLO
**Purpose:** High-security secret/data domain.

`services/vault`

Own:
- secrets
- encrypted records
- versions
- access policies
- access history
- expiration
- audit

Sensitive flow:
```text
Authentication
→ Workspace authorization
→ Vault permission
→ Optional step-up auth
→ Operation
→ Audit
```

Never log or unnecessarily return sensitive Vault content.

---

# PHASE 14 — WISP Mailbox Service
**Purpose:** WISP is both a product/domain and one of the 8 Telegram bots. It is not merely an SMTP sender.

`services/wisp`

Own:
- mailbox accounts
- inbox
- sent
- drafts
- threads
- folders/labels
- archive/trash/spam
- read/unread state
- message metadata
- attachments
- mailbox preferences
- mailbox permissions
- shared mailboxes if required
- search
- audit events

WISP bot examples:
```text
/inbox
/read
/reply
/compose
/draft
/sent
/search
/archive
/trash
```

Architecture:
```text
WISP Bot
 ↓
Telegram Gateway
 ↓
Identity + Workspace + Policy
 ↓
WISP Service
 ↓
Mailbox Storage
 ↓
Event Bus
 ├── Search
 ├── Notification
 ├── Mail Delivery
 └── Analytics
```

**Distinction**
```text
WISP = mailbox/product/domain
Mail Delivery = SMTP/provider delivery
Notification = cross-channel notifications
```

Security:
- mailbox authorization
- org isolation
- anti-IDOR
- attachment access control
- secure object storage
- abuse/spam controls
- audit
- rate limiting

---

# PHASE 15 — Mail Delivery Service
**Purpose:** Separate outbound email infrastructure from WISP.

`services/mail`

Own:
- SMTP/provider abstraction
- delivery
- retries
- bounces
- delivery status
- templates
- provider failover where needed

WISP uses this service rather than embedding provider logic.

---

# PHASE 16 — Notification Service
**Purpose:** Centralize cross-channel notifications.

Channels:
```text
Telegram
Email
Push
In-app
```

Example:
```text
finance.transaction.created
        ↓
Notification Service
 ├── Telegram
 ├── Email
 └── In-app
```

WISP also uses Notification rather than duplicating notification logic.

---

# PHASE 17 — Workflow Service / SKARN
**Purpose:** Independent automation/execution domain.

`services/workflow`

Own:
- workflow definitions
- triggers
- actions
- schedules
- execution history
- retries
- pause/resume
- failures

```text
SKARN → Workflow API → Workflow Service → Queue → Worker
```

Never execute arbitrary user code directly in the API process; use isolated/sandboxed workers where required.

---

# PHASE 18 — AI / Agent Service / ZYNTH
**Purpose:** Central AI capability without unrestricted system access.

`services/ai`

Components:
- model routing
- agent runtime
- context/memory
- tool registry
- permissions
- guardrails
- execution
- AI audit

```text
ZYNTH
 ↓
AI Gateway
 ↓
AI Service
 ↓
Tool Permission Layer
 ↓
Policy Check
 ↓
Specific Service
```

AI must never bypass normal authorization. Sensitive actions should require explicit confirmation where appropriate.

---

# PHASE 19 — VERVE Communication/Productivity
**Purpose:** Extract communication/productivity capabilities once core boundaries are stable.

Potential ownership:
- communication
- team activity
- collaboration
- productivity workflows
- activity feeds
- communication preferences

Derive the exact domain from the existing AYZEN implementation instead of inventing unsupported features.

---

# PHASE 20 — Marketplace / Search / Knowledge / Analytics
**Purpose:** Extract secondary/high-scale domains after core architecture is stable.

Marketplace:
- listings
- offers
- marketplace workflows

Search/Knowledge:
- indexing
- search
- knowledge retrieval
- document indexing

Analytics:
- event aggregation
- reports
- product analytics

Prefer consuming events over directly reading transactional databases.

---

# PHASE 21 — Observability
**Purpose:** Make the distributed system operable.

Structured logs should include:
```text
timestamp
level
service
request_id
correlation_id
trace_id
user_id
workspace_id
event
```

Metrics:
- request rate
- p50/p95/p99 latency
- errors
- queue depth
- event failures
- DB latency
- Telegram failures
- AI latency
- provider failures

Implement distributed tracing across gateway → service → DB/event → consumer.

Never log secrets.

---

# PHASE 22 — Testing & Contract Platform
**Purpose:** Raise testing to production-grade coverage.

Required:
```text
Unit
Integration
Contract
Security
E2E
Load
Failure/Recovery
```

Critical tests:
- privilege escalation
- workspace/org isolation
- IDOR
- token validation/revocation
- Telegram impersonation
- duplicate Telegram updates
- bot permission bypass
- Vault leakage
- AI tool escalation
- duplicate financial operations
- WISP mailbox authorization

Use OpenAPI/JSON Schema/Zod or equivalent for versioned API/event contracts.

---

# PHASE 23 — Frontend & Client Migration
**Purpose:** Hide internal topology from clients.

```text
Web → API Gateway → Services
```

Clients must not depend directly on internal service addresses.

Create typed API clients/shared contracts. Admin APIs must use explicit privileged permissions.

---

# PHASE 24 — Database Ownership
**Purpose:** Establish safe data boundaries.

Initially:
```text
One PostgreSQL Cluster
 ├── identity schema
 ├── workspace schema
 ├── finance schema
 ├── vault schema
 ├── wisp schema
 ├── workflow schema
 └── ...
```

Each service owns its schema.

Never allow:
```text
Finance → SELECT WISP tables
WISP → SELECT Finance tables
```

Later split databases only for real scale, isolation, compliance, reliability or performance requirements.

---

# PHASE 25 — Data Migration & Strangler Pattern
**Purpose:** Extract without big-bang downtime.

```text
Gateway
 ├── /finance/* → Finance Service
 ├── /vault/*   → Vault Service
 ├── /wisp/*    → WISP Service
 └── everything else → Monolith
```

Migration:
```text
Characterization tests
→ Backfill
→ Validate
→ Dual-read if necessary
→ Switch reads
→ Switch writes
→ Monitor
→ Remove old dependency
```

Every migration requires backup, validation and rollback.

---

# PHASE 26 — Containerized Development
**Purpose:** Run many services without requiring many physical servers.

Docker Compose can run:
```text
gateway
telegram-gateway
identity
workspace
finance
vault
wisp
workflow
ai
notification
mail
postgres
redis/event-bus
```

**Service ≠ physical server.**

---

# PHASE 27 — Staging
**Purpose:** Prove distributed behavior before production.

Use managed DB, queue/cache, object storage and secret management.

Run:
- smoke tests
- E2E
- security tests
- migration tests
- failure tests
- load tests

---

# PHASE 28 — Production Scaling
Scale according to actual metrics.

Example only:
```text
Gateway           ×3
Telegram Gateway  ×3
Identity          ×3
Workspace         ×2
Finance           ×3
Vault             ×2
WISP              ×3
Workflow          ×3
AI                ×5
Notification      ×3
Mail              ×2
```

These numbers are examples, not requirements.

---

# PHASE 29 — CI/CD
Pipeline:
```text
Commit
→ Lint
→ Typecheck
→ Unit Tests
→ Integration Tests
→ Security Scan
→ Build
→ Container Scan
→ Contract Tests
→ Staging
→ E2E
→ Approval
→ Production
```

Use immutable image/version tags and support rollback and safe migrations.

---

# PHASE 30 — Resilience & Failure Recovery
Assume every dependency can fail.

Implement:
- timeouts
- retries
- exponential backoff
- jitter
- circuit breakers where useful
- DLQ
- idempotency
- graceful shutdown
- health checks
- dependency isolation

Do not blindly retry non-idempotent finance, Vault, WISP send or external operations.

---

# PHASE 31 — Health & Operations
Every service:
```text
GET /health
GET /live
GET /ready
```

Define liveness, readiness and dependency health.

Create runbooks for:
- DB failure
- queue failure
- Telegram outage
- mail provider outage
- AI provider outage
- WISP storage outage
- identity outage

---

# PHASE 32 — Documentation & Governance
Every service:
```text
README.md
ARCHITECTURE.md
API.md
SECURITY.md
RUNBOOK.md
```

Document ownership, dependencies, DB ownership, APIs, events, permissions, secrets, monitoring and rollback.

Use ADRs for major architecture decisions.

---

# PHASE 33 — FINAL REPOSITORY TARGET
```text
ayzen/
├── apps/
│   ├── web/
│   ├── admin/
│   ├── gateway/
│   └── telegram-gateway/
├── services/
│   ├── identity/
│   ├── authorization/
│   ├── workspace/
│   ├── user/
│   ├── finance/
│   ├── vault/
│   ├── workflow/
│   ├── wisp/
│   ├── mail/
│   ├── notification/
│   ├── ai/
│   ├── marketplace/
│   ├── search/
│   └── analytics/
├── packages/
│   ├── auth/
│   ├── contracts/
│   ├── api-client/
│   ├── api-spec/
│   ├── events/
│   ├── telegram/
│   ├── policy/
│   ├── logger/
│   ├── telemetry/
│   ├── tracing/
│   ├── errors/
│   ├── config/
│   └── types/
├── infrastructure/
│   ├── docker/
│   ├── kubernetes/
│   ├── terraform/
│   ├── monitoring/
│   └── secrets/
├── tests/
├── docs/
└── scripts/
```

---

# PHASE 34 — CLAUDE CODE EXECUTION RULES
Claude must:

1. Inspect before changing.
2. Preserve working functionality.
3. Avoid unnecessary rewrites.
4. Maintain backward compatibility.
5. Add characterization tests before risky extraction.
6. Never create fake microservices.
7. Never share service databases.
8. Never hardcode secrets.
9. Never bypass authorization.
10. Never give AI unrestricted access.
11. Never put domain logic in Telegram handlers.
12. Never expose internal errors in production.
13. Never perform irreversible migrations without rollback.
14. Never declare completion without verification.

For every phase report:
```text
Completed
Files changed
Services created/changed
API changes
DB changes
Events
Security changes
Tests
Verification
Known risks
Rollback
Next phase
```

If a migration risks data loss, downtime or security/authorization regression, STOP before proceeding.

---

# PHASE 35 — DEFINITION OF DONE
A phase/service is complete only when:
```text
Architecture
+ Implementation
+ Tests
+ Security
+ Observability
+ Documentation
+ Migration
+ Rollback
```
are addressed.

---

# FINAL TARGET

```text
                 AYZEN ECOSYSTEM

      PERSONAL                    BUSINESS
         │                           │
      AYZENX                       WARDE
         │                           │
         └─────────────┬─────────────┘
                       │
                  API GATEWAY
                       │
       ┌───────────────┼────────────────┐
       │               │                │
    Identity       Workspace       Authorization
       │               │                │
       ├───────────────┼────────────────┤
       │               │                │
    Finance          Vault             WISP
     RYFT            SYLO              WISP
       │               │                │
       ├───────────────┼────────────────┤
       │               │                │
    Workflow           AI          Communication
     SKARN            ZYNTH             VERVE
       │               │
       └───────────────┼────────────────┘
                       │
                   EVENT BUS
                       │
             ┌─────────┼─────────┐
             │         │         │
        Notification  Mail    Analytics
                    Delivery
                       │
                Search/Knowledge
```

## Core principle

The goal is NOT:
**8 bots = 8 servers.**

The goal is:
**8 Telegram products/interfaces + well-bounded domain services + one coherent identity, workspace, authorization, security and observability model.**

A practical target is roughly **10–15 meaningful backend services**, not dozens of tiny services.
